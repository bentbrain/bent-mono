// Releases bent Fitness to TestFlight from an exact, qualified main commit.
//
//   bun run release:ios build --sha <full-sha> --config <private-file>
//   bun run release:ios credentials --config <private-file>
//
// `build` qualifies the commit, builds it on EAS from a fresh clone, checks
// the signed app and submits that exact build to TestFlight. `credentials`
// opens EAS's interactive credentials manager with the same Apple and Expo
// access, for the one-time signing and submission key setup.
import { spawn, spawnSync } from "node:child_process";
import { constants, createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { githubApi, requireReleaseChecks } from "../../../scripts/require-release-checks.mjs";
import { protectedJson } from "../../../scripts/release-vercel.mjs";
import { bundleIds, checkAppContents, checkHealthEntitlements, checkInfoPlist } from "./artifact.mjs";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(app, "../..");
const REPOSITORY_URL = "https://github.com/bentbrain/bent-mono.git";
const APP_DIRECTORY = "apps/fitness-ios";
const FITNESS_ORIGIN = "https://fitness.bent.build";
const XCODE = "26.6";
const IMAGE = "macos-tahoe-26.5-xcode-26.6";
const SHA = /^[a-f0-9]{40}$/;
const MINUTE = 60_000;
const fail = (message) => {
  throw new Error(message);
};

// ---------------------------------------------------------------- inputs

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  const usage =
    "Usage: bun run release:ios build --sha <full-sha> --config <private-file>\n" +
    "       bun run release:ios credentials --config <private-file>";
  if (!["build", "credentials"].includes(action)) fail(usage);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!["--sha", "--config"].includes(name) || !value || name in options) fail(usage);
    options[name] = value;
  }
  if (!options["--config"] || !isAbsolute(options["--config"])) fail(usage);
  if (action === "build" && !SHA.test(options["--sha"] ?? "")) fail(usage);
  if (action === "credentials" && options["--sha"]) fail(usage);
  return { action, sha: options["--sha"], configPath: options["--config"] };
}

/**
 * The protected release configuration: the App Store Connect team key, the
 * Apple team, the Expo token file and a private work directory outside any
 * checkout.
 */
export function validateConfig(config) {
  const absolute = (value) => typeof value === "string" && isAbsolute(value);
  if (
    !config ||
    typeof config !== "object" ||
    !absolute(config.ascKeyPath) ||
    !/^[A-Z0-9]{10}$/.test(config.ascKeyId ?? "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(config.ascIssuerId ?? "") ||
    !/^[A-Z0-9]{10}$/.test(config.appleTeamId ?? "") ||
    !["INDIVIDUAL", "COMPANY_OR_ORGANIZATION"].includes(config.appleTeamType) ||
    !absolute(config.expoTokenPath) ||
    !absolute(config.workDir)
  )
    fail(
      "The release configuration needs ascKeyPath, ascKeyId, ascIssuerId, appleTeamId, appleTeamType, expoTokenPath and workDir.",
    );
  const workDir = resolve(config.workDir);
  if (workDir === repoRoot || workDir.startsWith(`${repoRoot}${sep}`))
    fail("The release work directory must be outside the source checkout.");
  return { ...config, workDir };
}

/** Reads a private file owned by this user, as release-vercel.mjs does for JSON. */
async function privateText(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)
      fail("Release inputs must be private files owned by the operator.");
    return (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const real = await realpath(path);
  const metadata = await stat(real);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)
    fail("The release work directory must be private and owned by the operator.");
  return real;
}

/**
 * Variables that make Node, Bun, Expo or EAS print internals, such as
 * environments or request headers, that can include the Expo token. The
 * release refuses to start while any is set.
 */
const debugVariables = [
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_OPTIONS",
  "NODE_V8_COVERAGE",
  "DEBUG",
  "EXPO_DEBUG",
  "EXPO_PROFILE",
  "EAS_DEBUG",
  "EAS_VERBOSE",
  "BUN_CONFIG_VERBOSE_FETCH",
  "GIT_TRACE",
  "GIT_CURL_VERBOSE",
  "npm_config_loglevel",
  "NPM_CONFIG_LOGLEVEL",
];

/** The debug variables set in `environment`; the release needs none. */
export function unsafeDebugVariables(environment) {
  return debugVariables.filter((name) => (environment[name] ?? "").trim() !== "");
}

/** The only variables a child inherits from this shell. */
const inherited = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];

/** A child's environment: the allowlisted variables of `base`, plus `extra`. */
export function childEnvironment(base, extra = {}) {
  const environment = {};
  for (const name of inherited) if (base[name] !== undefined) environment[name] = base[name];
  return { ...environment, NO_COLOR: "1", ...extra };
}

/** The environment for EAS: the allowlist, the Expo token and the App Store Connect team key. */
export function easEnvironment(base, config, expoToken) {
  return childEnvironment(base, {
    EXPO_TOKEN: expoToken,
    EXPO_ASC_API_KEY_PATH: config.ascKeyPath,
    EXPO_ASC_KEY_ID: config.ascKeyId,
    EXPO_ASC_ISSUER_ID: config.ascIssuerId,
    EXPO_APPLE_TEAM_ID: config.appleTeamId,
    EXPO_APPLE_TEAM_TYPE: config.appleTeamType,
    EXPO_NO_DOTENV: "1",
    EAS_BUILD_NO_EXPO_GO_WARNING: "true",
  });
}

/**
 * The secret strings to keep out of anything the release prints: the Expo
 * token, and the App Store Connect key whole and line by line.
 */
export function secretsFrom(expoToken, ascKey) {
  const lines = ascKey
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 16 && !line.startsWith("-----"));
  return [expoToken, ascKey.trim(), ...lines].filter((value) => value.length >= 8);
}

/** `text` with each secret replaced by `[redacted]`. */
export function redact(text, secrets) {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[redacted]");
  return result;
}

/**
 * Redacts a stream as it arrives. It holds back only a tail that could be the
 * start of a secret, so prompts still show as they are written.
 */
export function redactingWriter(write, secrets) {
  let pending = "";
  const held = (text) => {
    let keep = 0;
    for (const secret of secrets)
      for (let length = Math.min(secret.length - 1, text.length); length > keep; length--)
        if (secret.startsWith(text.slice(text.length - length))) {
          keep = length;
          break;
        }
    return keep;
  };
  return {
    push(chunk) {
      const text = redact(pending + chunk, secrets);
      const keep = held(text);
      pending = text.slice(text.length - keep);
      if (text.length > keep) write(text.slice(0, text.length - keep));
    },
    end() {
      if (pending) write(redact(pending, secrets));
      pending = "";
    },
  };
}

// ---------------------------------------------------------------- processes

/** Secrets the release has read, for redaction. */
const secrets = [];

/**
 * Runs a command with a hard time limit and the allowlisted environment.
 * Output is returned, and shown only redacted, when the command fails.
 */
function run(command, args, { cwd, env = childEnvironment(process.env), timeout, input }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    timeout,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error?.code === "ETIMEDOUT")
    fail(`${command} ${args[0]} ran past its ${Math.round(timeout / MINUTE)}-minute limit.`);
  if (result.error) throw result.error;
  if (result.status !== 0)
    fail(
      `${command} ${args.slice(0, 2).join(" ")} failed with exit code ${result.status}.\n${redact(
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-4000),
        secrets,
      )}`,
    );
  return result;
}

/**
 * Runs a command with a hard time limit, showing its output redacted as it
 * arrives. `interactive` passes this terminal's input through.
 */
export function stream(
  command,
  args,
  { cwd, env, timeout, interactive = false, hidden = secrets, output = process.stdout, errors = process.stderr },
) {
  return new Promise((done, failed) => {
    const child = spawn(command, args, { cwd, env, stdio: [interactive ? "inherit" : "ignore", "pipe", "pipe"] });
    const out = redactingWriter((text) => output.write(text), hidden);
    const err = redactingWriter((text) => errors.write(text), hidden);
    child.stdout.setEncoding("utf8").on("data", (chunk) => out.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => err.push(chunk));
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      failed(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end();
      err.end();
      if (expired)
        failed(new Error(`${command} ${args[0]} ran past its ${Math.round(timeout / MINUTE)}-minute limit.`));
      else if (code !== 0) failed(new Error(`${command} ${args.slice(0, 2).join(" ")} failed with exit code ${code}.`));
      else done();
    });
  });
}

/** EAS CLI at the version eas.json pins, installed once into the work directory. */
function easCli(workDir, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail("eas.json must pin an exact EAS CLI version.");
  const prefix = join(workDir, `eas-cli-${version}`);
  const bin = join(prefix, "node_modules/eas-cli/bin/run");
  if (!existsSync(bin))
    run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", `eas-cli@${version}`], {
      cwd: workDir,
      timeout: 10 * MINUTE,
    });
  const installed = JSON.parse(
    run("node", ["-p", "JSON.stringify(require('eas-cli/package.json'))"], { cwd: prefix, timeout: MINUTE }).stdout,
  );
  if (installed.version !== version) fail(`Expected EAS CLI ${version}, found ${installed.version}.`);
  const eas = (args, options) => run("node", [bin, ...args], options);
  eas.stream = (args, options) => stream("node", [bin, ...args], options);
  return eas;
}

// ---------------------------------------------------------------- checks

/** A syntactically valid OAuth client ID that no Fitness deployment lists. */
export const unlistedClient = "release-check-unlisted-client";

/**
 * Fitness production must have enrollment on and accept tokens from the
 * build's OAuth client. `listed` is its reply for that client and `unlisted`
 * for one no deployment lists, which shows the deployment checks client IDs.
 */
export function checkReadiness(listed, unlisted) {
  const code = (reply) => (reply.body?.code ? `, ${reply.body.code}` : "");
  if (unlisted.status !== 403 || unlisted.body?.code !== "client_not_allowed")
    fail(
      `Fitness production does not check OAuth client IDs for readiness (HTTP ${unlisted.status}${code(unlisted)}). Release Fitness first.`,
    );
  if (listed.status !== 200 || listed.body?.enrollment !== "enabled")
    fail(
      `Fitness production is not ready to enroll devices with this build's OAuth client (HTTP ${listed.status}${code(listed)}).`,
    );
}

/** GET with a time limit and no redirects; 429 replies are retried once after Retry-After. */
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    const retry = Number(response.headers.get("retry-after"));
    if (response.status === 429 && attempt === 0 && retry > 0 && retry <= 60) {
      await new Promise((wake) => setTimeout(wake, retry * 1000));
      continue;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }
}

async function readiness(clientId) {
  const ready = `${FITNESS_ORIGIN}/api/health/devices/ready?clientId=`;
  checkReadiness(
    await getJson(ready + encodeURIComponent(clientId)),
    await getJson(ready + encodeURIComponent(unlistedClient)),
  );
}

/** Fitness production must name the build's OAuth issuer as its only authorization server. */
export function checkProtectedResource(metadata, issuer) {
  if (metadata?.resource !== `${FITNESS_ORIGIN}/api/mcp`)
    fail("Fitness production's protected-resource metadata names another resource.");
  if (JSON.stringify(metadata.authorization_servers) !== JSON.stringify([issuer]))
    fail("Fitness production uses another OAuth issuer than the production EAS environment.");
}

/** The privacy policy App Store Connect links to must be served. */
export function checkPrivacyPage(status, text) {
  if (status !== 200 || !text.includes("bent Fitness privacy"))
    fail(`${FITNESS_ORIGIN}/privacy is not serving the privacy policy (HTTP ${status}).`);
}

async function privacyPage() {
  const response = await fetch(`${FITNESS_ORIGIN}/privacy`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  checkPrivacyPage(response.status, await response.text());
}

/** `NAME=value` lines from `eas env:list --format short`. */
export function parseEnvList(text) {
  const variables = {};
  for (const line of text.split("\n")) {
    // eslint-disable-next-line no-control-regex
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.replace(/\u001b\[[0-9;]*m/g, "").trim());
    if (match) variables[match[1]] = match[2];
  }
  return variables;
}

/** The production EAS environment's OAuth settings, which the app build reads. */
export function checkOAuthSettings(variables) {
  const issuer = variables.FITNESS_OAUTH_ISSUER;
  const clientId = variables.FITNESS_OAUTH_CLIENT_ID;
  if (!issuer || !clientId)
    fail("Set FITNESS_OAUTH_ISSUER and FITNESS_OAUTH_CLIENT_ID in the production EAS environment.");
  if (!/^https:\/\/[^/]+$/.test(issuer.replace(/\/$/, ""))) fail("FITNESS_OAUTH_ISSUER must be an HTTPS origin.");
  return { issuer: issuer.replace(/\/$/, ""), clientId };
}

/** Clerk must offer the enrollment scope with PKCE S256. */
export function checkAuthorizationServer(metadata, issuer) {
  if (metadata?.issuer?.replace(/\/$/, "") !== issuer) fail("The OAuth issuer's metadata names another issuer.");
  if (!metadata.scopes_supported?.includes("fitness:health:enroll"))
    fail("The OAuth issuer does not offer the fitness:health:enroll scope.");
  if (!metadata.code_challenge_methods_supported?.includes("S256")) fail("The OAuth issuer does not offer PKCE S256.");
}

/** The EAS project ID that app.config.ts commits. */
export function projectIdFrom(appConfigSource) {
  const match = /projectId:\s*"([0-9a-f-]{36})"/.exec(appConfigSource);
  if (!match) fail("app.config.ts must name the EAS project ID.");
  return match[1];
}

/**
 * A build profile with its `extends` chain applied, as EAS merges it: the
 * profile's settings over its base's, with `ios` and `env` merged key by key.
 */
export function resolveProfile(profiles, name, seen = []) {
  const profile = profiles?.[name];
  if (!profile || typeof profile !== "object" || seen.includes(name)) fail(`eas.json has no usable "${name}" profile.`);
  if (profile.extends === undefined) return profile;
  const base = resolveProfile(profiles, profile.extends, [...seen, name]);
  const own = { ...profile };
  delete own.extends;
  return {
    ...base,
    ...own,
    ios: { ...base.ios, ...own.ios },
    env: { ...base.env, ...own.env },
  };
}

/** The release settings eas.json must keep. Returns the pinned EAS CLI version. */
export function checkEasJson(easJson) {
  if (easJson.cli?.requireCommit !== true) fail("eas.json must require a committed tree.");
  const production = resolveProfile(easJson.build, "production");
  if (production.ios?.image !== IMAGE) fail(`The production profile must build on ${IMAGE}.`);
  if (
    production.distribution !== "store" ||
    production.environment !== "production" ||
    production.env?.APP_VARIANT !== "production" ||
    production.developmentClient === true
  )
    fail("The production profile must build the production variant for the store.");
  if (!/^\d+$/.test(easJson.submit?.production?.ios?.ascAppId ?? ""))
    fail("eas.json must name the App Store Connect app for production submissions.");
  return easJson.cli.version;
}

/** The finished EAS build must be the exact source and the production app. */
export function checkBuild(builds, { sha, projectId }) {
  if (!Array.isArray(builds) || builds.length !== 1) fail("EAS must report exactly one build.");
  const [build] = builds;
  if (
    build.status !== "FINISHED" ||
    build.platform !== "IOS" ||
    build.buildProfile !== "production" ||
    build.distribution !== "STORE" ||
    build.isForIosSimulator !== false ||
    build.appIdentifier !== bundleIds.production ||
    build.gitCommitHash !== sha ||
    build.app?.id !== projectId ||
    !/^[0-9a-f-]{36}$/.test(build.id ?? "") ||
    !build.artifacts?.applicationArchiveUrl?.startsWith("https://")
  )
    fail("The EAS build is not the finished production build of the qualified commit.");
  return build;
}

/**
 * The app config the build embeds in EXConstants.bundle: the production
 * variant, the production origin, and the OAuth issuer and client checked
 * against production before the build.
 */
export function checkEmbeddedConfig(config, { issuer, clientId }) {
  const extra = config?.extra;
  const oauth = extra?.oauth;
  if (
    extra?.variant !== "production" ||
    extra.fitnessOrigin !== FITNESS_ORIGIN ||
    oauth?.issuer !== issuer ||
    oauth.clientId !== clientId ||
    oauth.resource !== `${FITNESS_ORIGIN}/api/mcp` ||
    oauth.redirectUri !== `${bundleIds.production}://oauth` ||
    config.ios?.bundleIdentifier !== bundleIds.production
  )
    fail("The build's embedded app config is not the production app with the checked OAuth issuer and client.");
}

/** Device code-signing entitlements: HealthKit exactly, and no debugging. */
export function checkSignedEntitlements(entitlements) {
  const health = checkHealthEntitlements(entitlements);
  if (entitlements["get-task-allow"] === true) fail("A TestFlight build must not allow debugging.");
  if (!String(entitlements["application-identifier"] ?? "").endsWith(`.${bundleIds.production}`))
    fail("The signed application identifier is not the production bundle ID.");
  return health;
}

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

/** Downloads the signed .ipa and checks what it carries. */
async function checkArchive(build, directory, oauth) {
  const archive = join(directory, "app.ipa");
  const response = await fetch(build.artifacts.applicationArchiveUrl, { signal: AbortSignal.timeout(20 * MINUTE) });
  if (!response.ok || !response.body) fail(`The build archive download failed with HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: "wx", mode: 0o600 }));
  const extracted = join(directory, "extracted");
  run("ditto", ["-x", "-k", archive, extracted], { timeout: 5 * MINUTE });
  const payload = join(extracted, "Payload");
  const apps = (await readdir(payload)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) fail("The archive must hold exactly one app.");
  const bundle = join(payload, apps[0]);
  const signed = run("codesign", ["-d", "--entitlements", "-", "--xml", bundle], { timeout: MINUTE }).stdout;
  const entitlements = JSON.parse(
    run("plutil", ["-convert", "json", "-o", "-", "-"], { input: signed, timeout: MINUTE }).stdout,
  );
  const health = checkSignedEntitlements(entitlements);
  const plist = JSON.parse(
    run("plutil", ["-convert", "json", "-o", "-", join(bundle, "Info.plist")], { timeout: MINUTE }).stdout,
  );
  checkInfoPlist(plist, "production");
  const binary = join(bundle, plist.CFBundleExecutable);
  const contents = (await files(bundle)).map((path) => relative(bundle, path));
  checkAppContents({ files: contents, code: (await readFile(binary)).toString("latin1") });
  const configs = contents.filter((path) => path.endsWith("EXConstants.bundle/app.config"));
  if (configs.length !== 1) fail("The archive must embed exactly one app config.");
  checkEmbeddedConfig(JSON.parse(await readFile(join(bundle, configs[0]), "utf8")), oauth);
  return { health, version: plist.CFBundleShortVersionString, buildNumber: plist.CFBundleVersion };
}

/** The build hook prints this line after checking the image's Xcode. */
export function checkXcodeLog(logs) {
  if (!logs.some((text) => text.includes(`Verified Xcode ${XCODE}.`)))
    fail(`The EAS build log does not show the Xcode ${XCODE} check.`);
}

async function buildLogs(build) {
  const logs = [];
  for (const url of build.logFiles ?? []) {
    if (!url.startsWith("https://")) continue;
    const response = await fetch(url, { signal: AbortSignal.timeout(2 * MINUTE) });
    if (response.ok) logs.push(await response.text());
  }
  return logs;
}

// ---------------------------------------------------------------- release

/** A fresh clone of the canonical repository at exactly `sha`. */
function pristineCheckout(sha, directory) {
  if (existsSync(directory)) fail(`${directory} already exists; each release uses a fresh clone.`);
  run("git", ["clone", "--quiet", "--no-checkout", REPOSITORY_URL, directory], { timeout: 10 * MINUTE });
  run("git", ["checkout", "--quiet", "--detach", sha], { cwd: directory, timeout: 5 * MINUTE });
  verifyCheckout(sha, directory);
}

function verifyCheckout(sha, directory) {
  const head = run("git", ["rev-parse", "HEAD"], { cwd: directory, timeout: MINUTE }).stdout.trim();
  const status = run("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: directory,
    timeout: MINUTE,
  }).stdout.trim();
  if (head !== sha || status) fail("The release checkout must be clean and at the exact source commit.");
  const ignores = run("git", ["ls-files", "--cached", "--others", "--", "*.easignore", ".easignore"], {
    cwd: directory,
    timeout: MINUTE,
  }).stdout.trim();
  if (ignores) fail("The release checkout must not contain an .easignore file.");
}

async function journal(path, record) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The release log's records, oldest first. */
async function journalRecords(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * A commit can be released again only while no build of it was requested: an
 * attempt that stopped before `eas build` left nothing on EAS. Once a build
 * may exist, the log and EAS need a person to reconcile them.
 */
export function checkPriorAttempts(records, sha) {
  const requested = records.filter(
    (record) =>
      record.sha === sha && ["build-requested", "built", "submit-requested", "submitted"].includes(record.status),
  );
  if (requested.length)
    fail(
      `A build of ${sha} was already requested (${requested.at(-1).status}). Check its EAS build and releases.jsonl before releasing it again.`,
    );
}

/** The OAuth settings the production EAS environment gives the build. */
const productionOAuth = (project) =>
  checkOAuthSettings(
    parseEnvList(
      project.eas(["env:list", "--environment", "production", "--format", "short"], project.options(2 * MINUTE)).stdout,
    ),
  );

/**
 * Admission: the commit's qualification, and production's acceptance of the
 * OAuth issuer and client the build uses, which must stay the same.
 */
async function admit(sha, project, expected) {
  const quality = await requireReleaseChecks(sha, githubApi);
  const oauth = productionOAuth(project);
  if (expected && (oauth.issuer !== expected.issuer || oauth.clientId !== expected.clientId))
    fail("The production EAS environment's OAuth settings changed during the release.");
  checkProtectedResource(await getJsonOk(`${FITNESS_ORIGIN}/.well-known/oauth-protected-resource`), oauth.issuer);
  await readiness(oauth.clientId);
  return { quality, oauth };
}

async function getJsonOk(url) {
  const reply = await getJson(url);
  if (reply.status !== 200) fail(`${url} replied HTTP ${reply.status}.`);
  return reply.body;
}

async function build({ sha, config }) {
  const workDir = await privateDirectory(config.workDir);
  const expoToken = await privateText(config.expoTokenPath);
  secrets.push(...secretsFrom(expoToken, await privateText(config.ascKeyPath)));
  const env = easEnvironment(process.env, config, expoToken);
  const journalPath = join(workDir, "releases.jsonl");
  checkPriorAttempts(await journalRecords(journalPath), sha);

  const quality = await requireReleaseChecks(sha, githubApi);
  // Each attempt has its own directory, so a stopped attempt's files stay.
  const release = join(workDir, sha, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(release, { recursive: true, mode: 0o700 });
  await journal(journalPath, { sha, status: "attempt-started", directory: release });
  const checkout = join(release, "source");
  pristineCheckout(sha, checkout);
  const appDir = join(checkout, APP_DIRECTORY);
  const easJson = JSON.parse(await readFile(join(appDir, "eas.json"), "utf8"));
  const eas = easCli(workDir, checkEasJson(easJson));
  const projectId = projectIdFrom(await readFile(join(appDir, "app.config.ts"), "utf8"));
  run("bun", ["install", "--frozen-lockfile"], { cwd: checkout, timeout: 20 * MINUTE });
  verifyCheckout(sha, checkout);

  const project = { eas, options: (timeout) => ({ cwd: appDir, env, timeout }) };
  const { oauth } = await admit(sha, project);
  checkAuthorizationServer(await getJsonOk(`${oauth.issuer}/.well-known/oauth-authorization-server`), oauth.issuer);

  // Admission again, immediately before the first change: the EAS build.
  const admitted = await admit(sha, project, oauth);
  if (admitted.quality.qualityRunId !== quality.qualityRunId) fail("Quality qualification changed during the release.");
  await journal(journalPath, { sha, status: "build-requested", quality });
  const builds = JSON.parse(
    eas(
      ["build", "--profile", "production", "--platform", "ios", "--non-interactive", "--json", "--wait"],
      project.options(150 * MINUTE),
    ).stdout,
  );
  const finished = checkBuild(builds, { sha, projectId });
  await journal(journalPath, { sha, status: "built", buildId: finished.id, appBuildVersion: finished.appBuildVersion });
  checkXcodeLog(await buildLogs(finished));
  const artifact = await checkArchive(finished, release, oauth);
  if (artifact.buildNumber !== finished.appBuildVersion || artifact.version !== finished.appVersion)
    fail("The archive's version does not match the EAS build.");

  // Admission again, immediately before submitting to TestFlight.
  const final = await admit(sha, project, oauth);
  if (final.quality.qualityRunId !== quality.qualityRunId) fail("Quality qualification changed during the release.");
  await privacyPage();
  await journal(journalPath, { sha, status: "submit-requested", buildId: finished.id });
  await eas.stream(
    ["submit", "--profile", "production", "--platform", "ios", "--id", finished.id, "--non-interactive", "--wait"],
    project.options(60 * MINUTE),
  );
  const record = {
    sha,
    status: "submitted",
    buildId: finished.id,
    bundleId: bundleIds.production,
    version: artifact.version,
    buildNumber: artifact.buildNumber,
    fingerprint: finished.fingerprint?.hash ?? null,
    entitlements: artifact.health,
    oauthClientId: oauth.clientId,
    quality,
  };
  await journal(journalPath, record);
  return record;
}

async function credentials({ config }) {
  const expoToken = await privateText(config.expoTokenPath);
  secrets.push(...secretsFrom(expoToken, await privateText(config.ascKeyPath)));
  const env = easEnvironment(process.env, config, expoToken);
  const version = checkEasJson(JSON.parse(await readFile(join(app, "eas.json"), "utf8")));
  const eas = easCli(await privateDirectory(config.workDir), version);
  await eas.stream(["credentials", "--platform", "ios"], { cwd: app, env, timeout: 30 * MINUTE, interactive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unsafe = unsafeDebugVariables(process.env);
  if (unsafe.length) fail(`Unset ${unsafe.join(", ")} first: debug output can include the Expo token.`);
  const { action, sha, configPath } = parseArgs(process.argv.slice(2));
  const config = validateConfig(await protectedJson(configPath));
  if (action === "credentials") await credentials({ config });
  else console.log(JSON.stringify(await build({ sha, config })));
}
