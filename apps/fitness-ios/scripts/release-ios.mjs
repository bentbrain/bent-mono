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
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
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

/** Failure output for display: redacted first, then cut to its last `limit` characters. */
export function failureDetail(text, hidden, limit = 4000) {
  return redact(text, hidden).slice(-limit);
}

/** The process IDs below `pid`, from `ps`. */
function descendants(pid) {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const children = new Map();
  for (const line of (listing.stdout ?? "").split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [];
  const queue = [pid];
  while (queue.length)
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  return found;
}

/**
 * Signals a child and everything below it: its process group, when it has
 * one, and each descendant. `known` collects the descendants found, so a
 * later signal still reaches one whose parent has already exited.
 */
function signalTree(child, signal, grouped, known = new Set()) {
  for (const pid of descendants(child.pid)) known.add(pid);
  if (grouped)
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is gone already.
    }
  for (const pid of [...known, child.pid])
    try {
      process.kill(pid, signal);
    } catch {
      // The process is gone already.
    }
}

/** Children still running, so an interrupted release stops them too. */
const running = new Set();
function stopChildrenOnInterrupt() {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      for (const { child, grouped } of running) signalTree(child, "SIGKILL", grouped);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
}

/**
 * Runs a command with a hard time limit and the allowlisted environment.
 *
 * A non-interactive command runs in its own process group. At the limit the
 * whole tree gets SIGTERM, then SIGKILL after `grace`, its pipes are closed
 * and the run fails at once, even if a descendant kept the pipes open. An
 * interactive command stays in the terminal's foreground group, so prompts
 * and Ctrl-C reach it, and its descendants are found with `ps` instead.
 *
 * With `show`, output is written redacted as it arrives. Otherwise it is
 * returned, and shown redacted only when the command fails.
 */
export function execute(
  command,
  args,
  {
    cwd,
    env = childEnvironment(process.env),
    timeout,
    input,
    interactive = false,
    show = interactive,
    hidden = secrets,
    output = process.stdout,
    errors = process.stderr,
    grace = 2000,
  },
) {
  return new Promise((done, failed) => {
    const grouped = !interactive;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: grouped,
      stdio: [interactive ? "inherit" : input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const entry = { child, grouped };
    running.add(entry);
    let stdout = "";
    let stderr = "";
    const out = redactingWriter((text) => output.write(text), hidden);
    const err = redactingWriter((text) => errors.write(text), hidden);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (show ? out.push(chunk) : (stdout += chunk)));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (show ? err.push(chunk) : (stderr += chunk)));
    if (input !== undefined) child.stdin.end(input);
    const timers = [];
    const known = new Set();
    let settled = false;
    let expired = false;
    const label = `${command} ${args.slice(0, 2).join(" ")}`;
    const limit =
      timeout >= MINUTE
        ? `${Math.round(timeout / MINUTE)}-minute`
        : `${Math.max(1, Math.round(timeout / 1000))}-second`;
    const settle = (error, code) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      running.delete(entry);
      // Descendants still running, or left holding the pipes, stop with the command.
      signalTree(child, "SIGKILL", grouped, known);
      child.stdout.destroy();
      child.stderr.destroy();
      out.end();
      err.end();
      const reject = (message) => failed(new Error(redact(message, hidden)));
      if (expired) reject(`${label} ran past its ${limit} limit.`);
      else if (error) failed(error);
      else if (code !== 0)
        reject(
          `${label} failed with exit code ${code}.${show ? "" : `\n${failureDetail(`${stdout}\n${stderr}`, hidden)}`}`,
        );
      else done({ stdout, stderr });
    };
    timers.push(
      setTimeout(() => {
        expired = true;
        signalTree(child, "SIGTERM", grouped, known);
        // Settles even while a descendant keeps the pipes open.
        timers.push(setTimeout(() => settle(), grace));
      }, timeout),
    );
    child.on("error", (error) => settle(error));
    // Output can still be arriving when the command exits; a descendant that
    // keeps the pipes open past `grace` does not hold the run.
    child.on("exit", (code, signal) => timers.push(setTimeout(() => settle(null, code ?? (signal ? 1 : 0)), grace)));
    child.on("close", (code, signal) => settle(null, code ?? (signal ? 1 : 0)));
  });
}

/** Runs a command and returns its output; see `execute`. */
const run = (command, args, options) => execute(command, args, { ...options, show: false });

/** EAS CLI at the version eas.json pins, installed once into the work directory. */
async function easCli(workDir, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail("eas.json must pin an exact EAS CLI version.");
  const prefix = join(workDir, `eas-cli-${version}`);
  const bin = join(prefix, "node_modules/eas-cli/bin/run");
  if (!existsSync(bin))
    await run(
      "npm",
      ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", `eas-cli@${version}`],
      {
        cwd: workDir,
        timeout: 10 * MINUTE,
      },
    );
  const installed = JSON.parse(
    (await run("node", ["-p", "JSON.stringify(require('eas-cli/package.json'))"], { cwd: prefix, timeout: MINUTE }))
      .stdout,
  );
  if (installed.version !== version) fail(`Expected EAS CLI ${version}, found ${installed.version}.`);
  const eas = (args, options) => run("node", [bin, ...args], options);
  eas.show = (args, options) => execute("node", [bin, ...args], { ...options, show: true });
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

/**
 * Clerk must know the build's OAuth client with its redirect URI and scope.
 * This starts an authorization request the way the app does, without
 * following redirects or signing in, so it grants nothing. Clerk sends a
 * request it has not checked yet through its sign-in page back to its own
 * authorize step; that step answers an unknown client with `invalid_client`,
 * a wrong redirect URI with `invalid_request`, and a scope the client may not
 * request with an `invalid_scope` redirect to the app. A known client goes on
 * to the consent page.
 */
export async function checkClientAtIssuer(
  { authorizationEndpoint, issuer, clientId, redirectUri, resource, scope = "fitness:health:enroll openid" },
  fetchImpl = fetch,
) {
  const origin = new URL(issuer).origin;
  const endpoint = new URL(authorizationEndpoint ?? "", issuer);
  if (endpoint.origin !== origin) fail("The OAuth issuer's authorization endpoint is on another origin.");
  const verifier = randomBytes(48).toString("base64url");
  endpoint.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    resource,
    state: randomBytes(16).toString("base64url"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const refused = (detail) => fail(`Clerk does not accept the build's OAuth client for this app (${detail}).`);
  let url = endpoint.href;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) {
      let code;
      try {
        code = (await response.json())?.error;
      } catch {
        code = undefined;
      }
      refused(`HTTP ${response.status}${code ? `, ${code}` : ""}`);
    }
    await response.body?.cancel();
    if (location.startsWith(redirectUri))
      refused(new URL(location).searchParams.get("error") ?? "redirected to the app");
    const next = new URL(location, url);
    if (next.origin === origin) {
      url = next.href;
      continue;
    }
    const back = next.searchParams.get("redirect_url");
    const returning = back ? new URL(back) : null;
    if (returning?.origin === origin) {
      url = returning.href;
      continue;
    }
    if (next.protocol !== "https:" || next.searchParams.has("error") || returning?.searchParams.has("error"))
      refused("an unexpected redirect");
    return;
  }
  refused("too many redirects");
}

/** The EAS project ID that app.config.ts commits. */
export function projectIdFrom(appConfigSource) {
  const match = /projectId:\s*"([0-9a-f-]{36})"/.exec(appConfigSource);
  if (!match) fail("app.config.ts must name the EAS project ID.");
  return match[1];
}

/** Merges two build profiles as eas-json does: `env`, `ios` and `android` merge key by key. */
function mergeProfiles(base, update) {
  const result = { ...base, ...update };
  if (base.env && update.env) result.env = { ...base.env, ...update.env };
  if (base.android && update.android) result.android = mergeProfiles(base.android, update.android);
  if (base.ios && update.ios) result.ios = mergeProfiles(base.ios, update.ios);
  return result;
}

/** A build profile with its `extends` chain applied, as eas-json 27.11.0 resolves it. */
export function resolveProfile(profiles, name, depth = 0) {
  if (depth >= 5) fail("eas.json has too long a chain of profile extensions, or a cycle.");
  const profile = profiles?.[name];
  if (!profile || typeof profile !== "object") fail(`eas.json has no usable "${name}" profile.`);
  const own = { ...profile };
  delete own.extends;
  return profile.extends === undefined ? own : mergeProfiles(resolveProfile(profiles, profile.extends, depth + 1), own);
}

/**
 * The settings an iOS build of `name` uses, as EAS resolves them: the
 * resolved profile, then its `ios` settings over the common ones, then
 * EAS's defaults under both.
 */
export function effectiveIosProfile(profiles, name) {
  const resolved = resolveProfile(profiles, name);
  const common = { ...resolved };
  delete common.ios;
  delete common.android;
  return mergeProfiles(
    { credentialsSource: "remote", distribution: "store" },
    mergeProfiles(common, resolved.ios ?? {}),
  );
}

/** Settings that change what kind of app a profile builds, which the release does not allow. */
const buildKindSettings = ["config", "prebuildCommand", "scheme", "enterpriseProvisioning", "withoutCredentials"];

/** The release settings eas.json must keep. Returns the pinned EAS CLI version. */
export function checkEasJson(easJson) {
  if (easJson.cli?.requireCommit !== true) fail("eas.json must require a committed tree.");
  const production = effectiveIosProfile(easJson.build, "production");
  if (production.image !== IMAGE) fail(`The production iOS build must use ${IMAGE}.`);
  if (
    production.distribution !== "store" ||
    production.environment !== "production" ||
    production.env?.APP_VARIANT !== "production" ||
    production.credentialsSource !== "remote" ||
    production.autoIncrement !== true ||
    production.simulator === true ||
    production.developmentClient === true ||
    (production.buildConfiguration !== undefined && production.buildConfiguration !== "Release") ||
    buildKindSettings.some((setting) => production[setting] !== undefined)
  )
    fail(
      "The production iOS build must be a Release store build of the production variant, in the production environment, with remote credentials and an incrementing build number.",
    );
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
  await run("ditto", ["-x", "-k", archive, extracted], { timeout: 5 * MINUTE });
  const payload = join(extracted, "Payload");
  const apps = (await readdir(payload)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) fail("The archive must hold exactly one app.");
  const bundle = join(payload, apps[0]);
  const signed = (await run("codesign", ["-d", "--entitlements", "-", "--xml", bundle], { timeout: MINUTE })).stdout;
  const entitlements = JSON.parse(
    (await run("plutil", ["-convert", "json", "-o", "-", "-"], { input: signed, timeout: MINUTE })).stdout,
  );
  const health = checkSignedEntitlements(entitlements);
  const plist = JSON.parse(
    (await run("plutil", ["-convert", "json", "-o", "-", join(bundle, "Info.plist")], { timeout: MINUTE })).stdout,
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
async function pristineCheckout(sha, directory) {
  if (existsSync(directory)) fail(`${directory} already exists; each release uses a fresh clone.`);
  await run("git", ["clone", "--quiet", "--no-checkout", REPOSITORY_URL, directory], { timeout: 10 * MINUTE });
  await run("git", ["checkout", "--quiet", "--detach", sha], { cwd: directory, timeout: 5 * MINUTE });
  await verifyCheckout(sha, directory);
}

async function verifyCheckout(sha, directory) {
  const git = async (args) => (await run("git", args, { cwd: directory, timeout: MINUTE })).stdout.trim();
  const head = await git(["rev-parse", "HEAD"]);
  const status = await git(["status", "--porcelain", "--untracked-files=normal"]);
  if (head !== sha || status) fail("The release checkout must be clean and at the exact source commit.");
  if (await git(["ls-files", "--cached", "--others", "--", "*.easignore", ".easignore"]))
    fail("The release checkout must not contain an .easignore file.");
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

/**
 * Claims a commit's build for this run. The claim is a file created only if
 * it does not exist, so of two runs that pass the journal check together,
 * one gets it. It stays once the build is requested, so every later run
 * refuses; `release` removes it only when the request never went out.
 */
export async function claimBuild(path, record) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      fail(
        `A run already claimed this commit's build (${path}). Check its EAS build and releases.jsonl before releasing it again.`,
      );
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { release: () => rm(path, { force: true }) };
}

/** The OAuth settings the production EAS environment gives the build. */
const productionOAuth = async (project) =>
  checkOAuthSettings(
    parseEnvList(
      (await project.eas(["env:list", "--environment", "production", "--format", "short"], project.options(2 * MINUTE)))
        .stdout,
    ),
  );

/**
 * Admission: the commit's qualification, and acceptance of the build's OAuth
 * issuer and client by Fitness production and by the issuer, which must stay
 * the same through the release.
 */
async function admit(sha, project, expected) {
  const quality = await requireReleaseChecks(sha, githubApi);
  const oauth = await productionOAuth(project);
  if (expected && (oauth.issuer !== expected.issuer || oauth.clientId !== expected.clientId))
    fail("The production EAS environment's OAuth settings changed during the release.");
  checkProtectedResource(await getJsonOk(`${FITNESS_ORIGIN}/.well-known/oauth-protected-resource`), oauth.issuer);
  await readiness(oauth.clientId);
  const metadata = await getJsonOk(`${oauth.issuer}/.well-known/oauth-authorization-server`);
  checkAuthorizationServer(metadata, oauth.issuer);
  await checkClientAtIssuer({
    authorizationEndpoint: metadata.authorization_endpoint,
    issuer: oauth.issuer,
    clientId: oauth.clientId,
    redirectUri: `${bundleIds.production}://oauth`,
    resource: `${FITNESS_ORIGIN}/api/mcp`,
  });
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
  const claimPath = join(workDir, sha, "build.claim");
  checkPriorAttempts(await journalRecords(journalPath), sha);
  if (existsSync(claimPath))
    fail(
      `A run already claimed this commit's build (${claimPath}). Check its EAS build and releases.jsonl before releasing it again.`,
    );

  const quality = await requireReleaseChecks(sha, githubApi);
  // Each attempt has its own directory, so a stopped attempt's files stay.
  const release = join(workDir, sha, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(release, { recursive: true, mode: 0o700 });
  await journal(journalPath, { sha, status: "attempt-started", directory: release });
  const checkout = join(release, "source");
  await pristineCheckout(sha, checkout);
  const appDir = join(checkout, APP_DIRECTORY);
  const easJson = JSON.parse(await readFile(join(appDir, "eas.json"), "utf8"));
  const eas = await easCli(workDir, checkEasJson(easJson));
  const projectId = projectIdFrom(await readFile(join(appDir, "app.config.ts"), "utf8"));
  await run("bun", ["install", "--frozen-lockfile"], { cwd: checkout, timeout: 20 * MINUTE });
  await verifyCheckout(sha, checkout);

  const project = { eas, options: (timeout) => ({ cwd: appDir, env, timeout }) };
  const { oauth } = await admit(sha, project);

  // Admission again, immediately before the first change: the EAS build.
  const admitted = await admit(sha, project, oauth);
  if (admitted.quality.qualityRunId !== quality.qualityRunId) fail("Quality qualification changed during the release.");
  checkEasJson(JSON.parse(await readFile(join(appDir, "eas.json"), "utf8")));
  const claim = await claimBuild(claimPath, { sha, attempt: release, at: new Date().toISOString() });
  try {
    await journal(journalPath, { sha, status: "build-requested", quality });
  } catch (error) {
    await claim.release();
    throw error;
  }
  const builds = JSON.parse(
    (
      await eas(
        ["build", "--profile", "production", "--platform", "ios", "--non-interactive", "--json", "--wait"],
        project.options(150 * MINUTE),
      )
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
  await eas.show(
    ["submit", "--profile", "production", "--platform", "ios", "--id", finished.id, "--non-interactive", "--wait"],
    project.options(60 * MINUTE),
  );
  const receipt = {
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
  // The full receipt stays in the private journal.
  await journal(journalPath, receipt);
  return receipt;
}

/** What the release prints when it finishes; the rest is in the journal. */
export const summary = ({ status, buildId, version, buildNumber }) => ({ status, buildId, version, buildNumber });

async function credentials({ config }) {
  const expoToken = await privateText(config.expoTokenPath);
  secrets.push(...secretsFrom(expoToken, await privateText(config.ascKeyPath)));
  const env = easEnvironment(process.env, config, expoToken);
  const version = checkEasJson(JSON.parse(await readFile(join(app, "eas.json"), "utf8")));
  const eas = await easCli(await privateDirectory(config.workDir), version);
  await eas.show(["credentials", "--platform", "ios"], { cwd: app, env, timeout: 30 * MINUTE, interactive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unsafe = unsafeDebugVariables(process.env);
  if (unsafe.length) fail(`Unset ${unsafe.join(", ")} first: debug output can include the Expo token.`);
  const { action, sha, configPath } = parseArgs(process.argv.slice(2));
  const config = validateConfig(await protectedJson(configPath));
  stopChildrenOnInterrupt();
  if (action === "credentials") await credentials({ config });
  else console.log(JSON.stringify(summary(await build({ sha, config }))));
}
