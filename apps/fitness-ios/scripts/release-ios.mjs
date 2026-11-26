// Release checks for bent Fitness, run by the Deploy Fitness iOS workflow
// (.github/workflows/deploy-fitness-ios.yml). The workflow runs the EAS CLI
// with the Expo token in the steps that need it; these subcommands check what
// those steps read and write, in files under $RUNNER_TEMP, without the token.
//
//   check-config [--out <path>]
//   check-profile --eas-package <eas-cli package.json>
//   oauth-env --env-file <eas env:list output>          (lines for $GITHUB_ENV)
//   admit [--current-env-file <eas env:list output>] [--check-privacy]   (reads RELEASE_OAUTH_*)
//   same-quality --initial <path> --current <path>
//   check-no-builds --sha <sha> --file <eas build:list JSON>
//   check-build --sha <sha> --build-file <eas build JSON> --downloads-dir <dir> --out <path>
//   verify-archive --archive <ipa> --logs-dir <dir> --build <path> --work-dir <dir> --out <path>
//   summary --file <verify-build output> --sha <sha> [--status <status>]
//
// Nothing here prints a signed URL: check-build writes the archive and log URLs
// to private files, and the workflow downloads them with curl.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { bundleIds, checkAppContents, checkHealthEntitlements, checkInfoPlist } from "./artifact.mjs";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(app, "../..");
const FITNESS_ORIGIN = "https://fitness.bent.build";
const XCODE = "26.6";
const IMAGE = "macos-tahoe-26.5-xcode-26.6";
const SHA = /^[a-f0-9]{40}$/;
const MINUTE = 60_000;
const fail = (message) => {
  throw new Error(message);
};

/** Runs a macOS tool with a hard time limit and returns its output. */
function tool(command, args, { input, timeout = MINUTE } = {}) {
  return execFileSync(command, args, {
    input,
    timeout,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
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
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(issuer.replace(/\/$/, "")))
    fail("FITNESS_OAUTH_ISSUER must be an HTTPS origin.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId))
    fail("FITNESS_OAUTH_CLIENT_ID must be letters, digits, hyphens or underscores.");
  return { issuer: issuer.replace(/\/$/, ""), clientId };
}

/** Clerk must offer the enrollment scope with PKCE S256. */
export function checkAuthorizationServer(metadata, issuer) {
  if (metadata?.issuer?.replace(/\/$/, "") !== issuer) fail("The OAuth issuer's metadata names another issuer.");
  if (!metadata.scopes_supported?.includes("fitness:health:enroll"))
    fail("The OAuth issuer does not offer the fitness:health:enroll scope.");
  if (!metadata.code_challenge_methods_supported?.includes("S256")) fail("The OAuth issuer does not offer PKCE S256.");
}

/** The authorization parameters Clerk must carry, unchanged, through each step of its flow. */
const authorizationParameters = [
  "client_id",
  "redirect_uri",
  "scope",
  "resource",
  "state",
  "code_challenge",
  "code_challenge_method",
  "response_type",
];

/** Whether `url` carries exactly `expected`'s authorization parameters, each once, and nothing else. */
export function carriesParameters(url, expected) {
  const keys = [...url.searchParams.keys()];
  return (
    keys.length === authorizationParameters.length &&
    authorizationParameters.every(
      (name) => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === expected.get(name),
    )
  );
}

/** An HTTPS URL on the default port, with no user information or fragment, not even a bare "#". */
export function plainHttps(url) {
  // `hash` is "" for a bare trailing "#", which the serialized URL keeps.
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password && !url.href.includes("#");
}

/** The redirect statuses an authorization step may answer with. */
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/**
 * Clerk's sign-in page for this instance, from the instance's own
 * environment on the issuer origin: an HTTPS `/sign-in` page. Its origin is
 * the accounts host the authorization flow must use.
 */
export function signInPage(environment) {
  let page;
  try {
    page = new URL(environment?.display_config?.sign_in_url ?? "");
  } catch {
    fail("The OAuth issuer's environment names no sign-in page.");
  }
  if (!plainHttps(page) || page.pathname !== "/sign-in" || page.search)
    fail("The OAuth issuer's sign-in page is not an HTTPS /sign-in page.");
  return page;
}

/**
 * Clerk must know the build's OAuth client with its redirect URI and scope.
 * This starts an authorization request the way the app does, without
 * following redirects or signing in, so it grants nothing. Clerk's flow is
 * checked step by step, with every redirect exact:
 *
 * 1. The issuer's `/oauth/authorize` sends the browser to the instance's
 *    sign-in page, returning to the issuer's own
 *    `/oauth/authorize-with-immediate-redirect`.
 * 2. That step checks the client. It answers an unknown client with
 *    `invalid_client`, a redirect URI the client does not have with
 *    `invalid_request`, and a scope the client may not request with an
 *    `invalid_scope` redirect to the app. A known client goes to the sign-in
 *    page again, returning to `/oauth-consent` on the accounts host.
 *
 * Both returns must carry the request's eight authorization parameters
 * exactly. Anything else stops the release.
 */
export async function checkClientAtIssuer(
  { authorizationEndpoint, issuer, clientId, redirectUri, resource, scope = "fitness:health:enroll openid" },
  fetchImpl = fetch,
) {
  const origin = new URL(issuer).origin;
  const endpoint = new URL(authorizationEndpoint ?? "", issuer);
  if (endpoint.origin !== origin || endpoint.pathname !== "/oauth/authorize")
    fail("The OAuth issuer's authorization endpoint is not its own /oauth/authorize.");
  const refused = (detail) => fail(`Clerk does not accept the build's OAuth client for this app (${detail}).`);
  const get = (url) => fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });

  const environment = await get(`${origin}/v1/environment`);
  if (environment.status !== 200) refused(`its environment replied HTTP ${environment.status}`);
  const signIn = signInPage(await environment.json());

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
  const expected = endpoint.searchParams;

  /** One step: a redirect to the sign-in page that returns to `back` with the parameters. */
  const step = async (url, back) => {
    const response = await get(url);
    const location = response.headers.get("location");
    if (!redirectStatuses.has(response.status) || !location) {
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
    const page = new URL(location, url);
    if (
      !plainHttps(page) ||
      page.origin !== signIn.origin ||
      page.pathname !== signIn.pathname ||
      [...page.searchParams.keys()].join() !== "redirect_url"
    )
      refused("a redirect to another page than the instance's sign-in");
    let returning;
    try {
      returning = new URL(page.searchParams.get("redirect_url"));
    } catch {
      refused("a sign-in redirect without a return address");
    }
    if (!plainHttps(returning) || returning.origin !== back.origin || returning.pathname !== back.pathname)
      refused(`a sign-in redirect returning to ${returning.origin}${returning.pathname}`);
    if (!carriesParameters(returning, expected)) refused("a sign-in redirect with changed authorization parameters");
    return returning;
  };

  const check = await step(endpoint.href, new URL("/oauth/authorize-with-immediate-redirect", origin));
  await step(check.href, new URL("/oauth-consent", signIn.origin));
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

/**
 * Checks an effective iOS build profile. Each value must have its exact type:
 * eas-json reads `"true"` as `true` for booleans, so a boolean that may be
 * set must be literally `false`, or literally `true` for `autoIncrement`.
 */
export function checkIosBuild(profile) {
  const problems = [];
  const exactly = (name, value) => profile[name] === value || problems.push(`${name} must be ${JSON.stringify(value)}`);
  const offOrAbsent = (name) =>
    profile[name] === undefined || profile[name] === false || problems.push(`${name} must be absent or false`);
  const absent = (name) => profile[name] === undefined || problems.push(`${name} must be absent`);
  exactly("image", IMAGE);
  exactly("distribution", "store");
  exactly("environment", "production");
  exactly("credentialsSource", "remote");
  exactly("autoIncrement", true);
  for (const name of ["simulator", "developmentClient", "withoutCredentials"]) offOrAbsent(name);
  for (const name of ["enterpriseProvisioning", "config", "prebuildCommand", "scheme"]) absent(name);
  if (profile.buildConfiguration !== undefined && profile.buildConfiguration !== "Release")
    problems.push('buildConfiguration must be absent or "Release"');
  if (profile.env?.APP_VARIANT !== "production") problems.push('env.APP_VARIANT must be "production"');
  if (problems.length)
    fail(`The production iOS build must be a Release store build of the production variant: ${problems.join("; ")}.`);
}

/** The release settings eas.json must keep. Returns the pinned EAS CLI version. */
export function checkEasJson(easJson) {
  if (easJson.cli?.requireCommit !== true) fail("eas.json must require a committed tree.");
  checkIosBuild(effectiveIosProfile(easJson.build, "production"));
  if (!/^\d+$/.test(easJson.submit?.production?.ios?.ascAppId ?? ""))
    fail("eas.json must name the App Store Connect app for production submissions.");
  if (typeof easJson.cli.version !== "string") fail("eas.json must pin an exact EAS CLI version.");
  return easJson.cli.version;
}

/**
 * The production iOS profile as the pinned EAS CLI itself resolves it, with
 * eas-json's validation and type conversion, so the checks see what EAS builds.
 */
export async function pinnedIosProfile(easCliPackage, projectDir) {
  const { EasJsonAccessor, EasJsonUtils } = createRequire(easCliPackage)("@expo/eas-json");
  return EasJsonUtils.getBuildProfileAsync(EasJsonAccessor.fromProjectPath(projectDir), "ios", "production");
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

/** Checks what the signed .ipa at `archive` carries. */
async function checkArchive(archive, directory, oauth) {
  const extracted = join(directory, "extracted");
  tool("ditto", ["-x", "-k", archive, extracted], { timeout: 5 * MINUTE });
  const payload = join(extracted, "Payload");
  const apps = (await readdir(payload)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) fail("The archive must hold exactly one app.");
  const bundle = join(payload, apps[0]);
  const signed = tool("codesign", ["-d", "--entitlements", "-", "--xml", bundle]);
  const entitlements = JSON.parse(tool("plutil", ["-convert", "json", "-o", "-", "-"], { input: signed }));
  const health = checkSignedEntitlements(entitlements);
  const plist = JSON.parse(tool("plutil", ["-convert", "json", "-o", "-", join(bundle, "Info.plist")]));
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

/**
 * EAS must have no production iOS build of the commit yet. This covers
 * every run, wherever it started.
 */
export function checkNoEasBuilds(builds, sha) {
  if (!Array.isArray(builds)) fail("EAS did not list the commit's builds.");
  const existing = builds.filter((build) => build.gitCommitHash === sha && build.buildProfile === "production");
  if (existing.length)
    fail(
      `EAS already has a production build of ${sha} (${existing.map((build) => `${build.id} ${build.status}`).join(", ")}). Check that build before releasing the commit again.`,
    );
}

async function getJsonOk(url) {
  const reply = await getJson(url);
  if (reply.status !== 200) fail(`${url} replied HTTP ${reply.status}.`);
  return reply.body;
}

/** What a release reports when it finishes: no URLs and nothing secret. */
export const summary = ({ status, buildId, version, buildNumber }) => ({ status, buildId, version, buildNumber });

/**
 * The OAuth issuer and client handed to later workflow steps, as
 * `NAME=value` lines for $GITHUB_ENV. Both are checked to a strict pattern,
 * so neither can carry a line break or another variable.
 */
export function oauthEnvironment(envList) {
  const { issuer, clientId } = checkOAuthSettings(parseEnvList(envList));
  return `RELEASE_OAUTH_ISSUER=${issuer}\nRELEASE_OAUTH_CLIENT_ID=${clientId}\n`;
}

/** The OAuth issuer and client from this step's environment, checked again. */
export function oauthFromEnvironment(environment = process.env) {
  return checkOAuthSettings({
    FITNESS_OAUTH_ISSUER: environment.RELEASE_OAUTH_ISSUER,
    FITNESS_OAUTH_CLIENT_ID: environment.RELEASE_OAUTH_CLIENT_ID,
  });
}

/**
 * The build's OAuth issuer and client, accepted by Fitness production and by
 * the issuer. `current`, when given, is the production EAS environment read
 * again, which must still name the same issuer and client.
 */
export async function admit(oauth, current) {
  if (current !== undefined) {
    const now = checkOAuthSettings(parseEnvList(current));
    if (now.issuer !== oauth.issuer || now.clientId !== oauth.clientId)
      fail("The production EAS environment's OAuth settings changed during the release.");
  }
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
}

/** The two qualifications of one release must name the same Quality run. */
export function checkSameQuality(initial, current) {
  if (
    !Number.isSafeInteger(initial?.qualityRunId) ||
    initial.sha !== current?.sha ||
    initial.qualityRunId !== current.qualityRunId ||
    initial.qualityAttempt !== current.qualityAttempt
  )
    fail("Quality qualification changed during the release.");
}

/** The repository must have no .easignore, so EAS uploads exactly the commit. */
export function checkNoEasIgnore(root = repoRoot) {
  for (const path of [join(root, ".easignore"), join(root, "apps/fitness-ios/.easignore")])
    if (existsSync(path)) fail("The release checkout must not contain an .easignore file.");
}

/** A signed download URL from EAS: HTTPS, on one line, with nothing a shell could split. */
const downloadUrl = (url) =>
  typeof url === "string" && /^https:\/\/[^\s"'`$\\]+$/.test(url) ? url : fail("EAS gave a malformed download URL.");

/**
 * Checks the finished EAS build and returns what the workflow downloads,
 * by curl so these URLs are never printed, and what the archive must match.
 */
export function buildDownloads(builds, { sha, projectId }) {
  const build = checkBuild(builds, { sha, projectId });
  return {
    archive: downloadUrl(build.artifacts.applicationArchiveUrl),
    logs: (build.logFiles ?? []).map(downloadUrl),
    build: { buildId: build.id, version: build.appVersion, buildNumber: build.appBuildVersion },
  };
}

/** Checks the downloaded archive and logs against the build, and returns the build's safe summary. */
async function verifyArchive({ archive, logsDir, build, oauth, workDir }) {
  const logs = [];
  for (const name of (await readdir(logsDir)).sort()) logs.push(await readFile(join(logsDir, name), "utf8"));
  checkXcodeLog(logs);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const artifact = await checkArchive(archive, workDir, oauth);
  if (artifact.buildNumber !== build.buildNumber || artifact.version !== build.version)
    fail("The archive's version does not match the EAS build.");
  return summary({
    status: "built",
    buildId: build.buildId,
    version: artifact.version,
    buildNumber: artifact.buildNumber,
  });
}

/** The step summary: status, commit, build, version and build number. */
export function summaryMarkdown(result, sha) {
  const { status, buildId, version, buildNumber } = summary(result);
  return [
    "## bent Fitness iOS release",
    "",
    "| Status | Commit | Build | Version | Build number |",
    "| --- | --- | --- | --- | --- |",
    `| ${status} | \`${sha}\` | \`${buildId}\` | ${version} | ${buildNumber} |`,
    "",
  ].join("\n");
}

/** Reads `--name value` and `--flag` options for a subcommand. */
export function options(argv, { values = [], flags = [] }) {
  const found = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (flags.includes(name)) found[name] = true;
    else if (values.includes(name) && argv[index + 1] !== undefined && !(name in found)) found[name] = argv[++index];
    else fail(`Unexpected argument ${name}.`);
  }
  return found;
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const requireSha = (sha) => (SHA.test(sha ?? "") ? sha : fail("Pass the full 40-character commit SHA."));
const required = (found, name) => found[name] ?? fail(`Pass ${name}.`);

/** The pinned EAS CLI version and the EAS project, from the committed config. */
export async function configSummary(root = repoRoot) {
  checkNoEasIgnore(root);
  const easCliVersion = checkEasJson(await readJson(join(root, "apps/fitness-ios/eas.json")));
  if (!/^\d+\.\d+\.\d+$/.test(easCliVersion)) fail("eas.json must pin an exact EAS CLI version.");
  const projectId = projectIdFrom(await readFile(join(root, "apps/fitness-ios/app.config.ts"), "utf8"));
  return { easCliVersion, projectId };
}

const commands = {
  async "check-config"(argv) {
    const found = options(argv, { values: ["--out"] });
    const config = await configSummary();
    if (found["--out"]) await writeJson(found["--out"], config);
    console.log(JSON.stringify(config));
  },
  async "check-profile"(argv) {
    const found = options(argv, { values: ["--eas-package"] });
    checkIosBuild(await pinnedIosProfile(resolve(required(found, "--eas-package")), app));
    console.log("The production iOS profile is a Release store build of the production variant.");
  },
  async "oauth-env"(argv) {
    const found = options(argv, { values: ["--env-file"] });
    process.stdout.write(oauthEnvironment(await readFile(required(found, "--env-file"), "utf8")));
  },
  async admit(argv) {
    const found = options(argv, { values: ["--current-env-file"], flags: ["--check-privacy"] });
    const current = found["--current-env-file"] ? await readFile(found["--current-env-file"], "utf8") : undefined;
    await admit(oauthFromEnvironment(), current);
    if (found["--check-privacy"]) await privacyPage();
    console.log("Fitness production and the OAuth issuer accept the build's OAuth client.");
  },
  async "same-quality"(argv) {
    const found = options(argv, { values: ["--initial", "--current"] });
    checkSameQuality(await readJson(required(found, "--initial")), await readJson(required(found, "--current")));
    console.log("Quality qualification is unchanged.");
  },
  async "check-no-builds"(argv) {
    const found = options(argv, { values: ["--sha", "--file"] });
    checkNoEasBuilds(await readJson(required(found, "--file")), requireSha(found["--sha"]));
    console.log("EAS has no production build of this commit.");
  },
  async "check-build"(argv) {
    const found = options(argv, { values: ["--sha", "--build-file", "--downloads-dir", "--out"] });
    const downloads = buildDownloads(await readJson(required(found, "--build-file")), {
      sha: requireSha(found["--sha"]),
      projectId: (await configSummary()).projectId,
    });
    const directory = required(found, "--downloads-dir");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "archive-url"), `${downloads.archive}\n`, { mode: 0o600 });
    await writeFile(join(directory, "log-urls"), downloads.logs.map((url) => `${url}\n`).join(""), { mode: 0o600 });
    await writeJson(required(found, "--out"), downloads.build);
    console.log(`EAS build ${downloads.build.buildId} is the finished production build of this commit.`);
  },
  async "verify-archive"(argv) {
    const found = options(argv, { values: ["--archive", "--logs-dir", "--build", "--work-dir", "--out"] });
    const result = await verifyArchive({
      archive: resolve(required(found, "--archive")),
      logsDir: resolve(required(found, "--logs-dir")),
      build: await readJson(required(found, "--build")),
      oauth: oauthFromEnvironment(),
      workDir: resolve(required(found, "--work-dir")),
    });
    await writeJson(required(found, "--out"), result);
    console.log(JSON.stringify(result));
  },
  async summary(argv) {
    const found = options(argv, { values: ["--file", "--sha", "--status"] });
    const result = await readJson(required(found, "--file"));
    if (found["--status"]) result.status = found["--status"];
    process.stdout.write(summaryMarkdown(result, requireSha(found["--sha"])));
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...argv] = process.argv.slice(2);
  const command = commands[name] ?? fail(`Run one of: ${Object.keys(commands).join(", ")}.`);
  await command(argv);
}
