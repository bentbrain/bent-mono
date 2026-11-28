// Release checks for bent Fitness, run by the Deploy Fitness iOS workflow
// (.github/workflows/deploy-fitness-ios.yml). The workflow runs the EAS CLI
// with the Expo token in the steps that need it; these subcommands check what
// those steps read and write, in files under $RUNNER_TEMP, without the token.
//
//   check-config [--out <path>] [--static-dir <dir>]
//   check-profile --eas-package <eas-cli package.json>
//   oauth-env --env-file <eas env:list output> --out <path>
//   oauth-value --oauth-file <oauth-env output> --name issuer|clientId
//   admit [--current-env-file <eas env:list output>] [--check-privacy]   (reads RELEASE_OAUTH_* from its step)
//   same-quality --initial <path> --current <path>
//   check-build --sha <sha> --build-file <eas build JSON> --downloads-dir <dir> --out <path>
//   submissions-query (--build-list <eas build:list JSON> --sha <sha> | --build-id <id>) --out <path>
//   check-no-submissions (--build-list <path> --sha <sha> | --build-id <id>) --file <EAS GraphQL reply>
//   submission-status --build-id <id> --file <EAS GraphQL reply>
//   verify-archive --archive <ipa> --logs-dir <dir> --build <path> --oauth-file <path> --work-dir <dir> --out <path>
//   summary --file <verify-build output> --sha <sha> [--status <status>]
//
// Nothing here prints a signed URL: check-build writes the archive and log URLs
// into private curl config files, which the workflow downloads with curl.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  bundleIds,
  checkAppContents,
  checkAppEntitlements,
  checkExtensionContents,
  checkExtensionEntitlements,
  checkExtensionInfoPlist,
  checkInfoPlist,
  extensionBinary,
  extensionBundleId,
} from "./artifact.mjs";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(app, "../..");
const FITNESS_ORIGIN = "https://fitness.bent.build";
const XCODE = "26.6";
const IMAGE = "macos-tahoe-26.5-xcode-26.6";
const SHA = /^[a-f0-9]{40}$/;
const MINUTE = 60_000;
/** A check's own failure. Its message is fixed text and validated values only, never response content. */
export class ReleaseError extends Error {}
const fail = (message) => {
  throw new ReleaseError(message);
};

/** An EAS build or submission ID: a string in UUID form. */
export const isUuid = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** The codes Fitness's `/api/health/devices/ready` replies with (apps/fitness/src/server/devices.ts). */
export const readinessCodes = new Set([
  "enrollment_unavailable",
  "client_not_allowed",
  "invalid_request",
  "rate_limited",
]);

/**
 * The OAuth 2.0 error codes Clerk's authorize steps return: the authorization
 * error codes (RFC 6749, section 4.1.2.1), and `invalid_client` (section 5.2),
 * which Clerk returns for an unknown client.
 */
export const oauthErrorCodes = new Set([
  "invalid_request",
  "invalid_client",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

/** A provider's error code, shown only when it is one of `known`; anything else is left out. */
export const knownCode = (known, code) => (typeof code === "string" && known.has(code) ? code : null);

/** A CFBundleShortVersionString or CFBundleVersion: one to three period-separated whole numbers. */
export const isBundleVersion = (value) =>
  typeof value === "string" && value.length <= 18 && /^\d{1,6}(\.\d{1,6}){0,2}$/.test(value);

/** The statuses a release reports. */
const releaseStatuses = new Set(["built", "submitted"]);

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
  const code = (reply) => {
    const known = knownCode(readinessCodes, reply.body?.code);
    return known ? `, ${known}` : "";
  };
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
  if (typeof issuer !== "string" || typeof clientId !== "string" || !issuer || !clientId)
    fail("Set FITNESS_OAUTH_ISSUER and FITNESS_OAUTH_CLIENT_ID in the production EAS environment.");
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(issuer.replace(/\/$/, "")))
    fail("FITNESS_OAUTH_ISSUER must be an HTTPS origin.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId))
    fail("FITNESS_OAUTH_CLIENT_ID must be letters, digits, hyphens or underscores.");
  return { issuer: issuer.replace(/\/$/, ""), clientId };
}

/**
 * The scopes the app requests when it signs in. Keep this equal to the
 * scopes in src/config/variants.ts; tests/release.test.mjs checks it.
 */
export const appScope = "openid offline_access fitness:read fitness:write fitness:health:enroll";

/** Clerk must offer every scope the app requests, with PKCE S256. */
export function checkAuthorizationServer(metadata, issuer) {
  if (metadata?.issuer?.replace(/\/$/, "") !== issuer) fail("The OAuth issuer's metadata names another issuer.");
  for (const scope of appScope.split(" "))
    if (!metadata.scopes_supported?.includes(scope)) fail(`The OAuth issuer does not offer the ${scope} scope.`);
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
 * 1. The issuer's `/oauth/authorize` either redirects to its own
 *    `/oauth/authorize/continue`, or sends the browser to the instance's
 *    sign-in page returning to its own `/oauth/authorize-with-immediate-redirect`.
 *    Clerk instances use one flow or the other.
 * 2. That step checks the client. It answers an unknown client with
 *    `invalid_client`, a redirect URI the client does not have with
 *    `invalid_request`, and a scope the client may not request with an
 *    `invalid_scope` redirect to the app. A known client goes to the sign-in
 *    page again, returning to `/oauth-consent` on the accounts host.
 *
 * Every hop must carry the request's eight authorization parameters
 * exactly. Anything else stops the release.
 */
export async function checkClientAtIssuer(
  { authorizationEndpoint, issuer, clientId, redirectUri, resource, scope = appScope },
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

  /** The redirect target of `response`, or a refusal naming Clerk's answer. */
  const redirectOf = async (response, url) => {
    const location = response.headers.get("location");
    if (!redirectStatuses.has(response.status) || !location) {
      let code;
      try {
        code = (await response.json())?.error;
      } catch {
        code = undefined;
      }
      const known = knownCode(oauthErrorCodes, code);
      refused(`HTTP ${Number(response.status)}${known ? `, ${known}` : ""}`);
    }
    await response.body?.cancel();
    if (location.startsWith(redirectUri))
      refused(knownCode(oauthErrorCodes, new URL(location).searchParams.get("error")) ?? "redirected to the app");
    return new URL(location, url);
  };

  /** One step: a redirect to the sign-in page that returns to `back` with the parameters. */
  const step = async (url, back, response) => {
    const page = await redirectOf(response ?? (await get(url)), url);
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
      refused(`a sign-in redirect returning to another page than ${back.pathname}`);
    if (!carriesParameters(returning, expected)) refused("a sign-in redirect with changed authorization parameters");
    return returning;
  };

  const first = await get(endpoint.href);
  const target = first.headers.get("location");
  const direct = target && !target.startsWith(redirectUri) ? new URL(target, endpoint) : null;
  let check;
  if (
    direct &&
    redirectStatuses.has(first.status) &&
    direct.origin === origin &&
    direct.pathname === "/oauth/authorize/continue"
  ) {
    await first.body?.cancel();
    if (!plainHttps(direct) || !carriesParameters(direct, expected))
      refused("a continuation with changed authorization parameters");
    check = direct;
  } else {
    check = await step(endpoint.href, new URL("/oauth/authorize-with-immediate-redirect", origin), first);
  }
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
    !isUuid(build.id) ||
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

/**
 * Device code-signing entitlements: HealthKit and the App Group exactly, no
 * other capability, no debugging, and exactly the production application
 * identifier. Returns the HealthKit keys and the signing team.
 */
export function checkSignedEntitlements(entitlements) {
  const health = checkAppEntitlements(entitlements, "production");
  if (entitlements["get-task-allow"] !== undefined && entitlements["get-task-allow"] !== false)
    fail("A TestFlight build must not allow debugging.");
  const team = /^([A-Z0-9]{10})\./.exec(String(entitlements["application-identifier"] ?? ""))?.[1];
  if (!team) fail("The signed application identifier is not the production bundle ID.");
  return { health, team };
}

/**
 * The widget extension's signed entitlements: the App Group exactly, no
 * other capability, no debugging, and exactly the production extension
 * identifier under the app's team.
 */
export function checkSignedExtensionEntitlements(entitlements, team) {
  checkExtensionEntitlements(entitlements, "production");
  if (entitlements["get-task-allow"] !== undefined && entitlements["get-task-allow"] !== false)
    fail("A TestFlight build must not allow debugging.");
  if (entitlements["application-identifier"] !== `${team}.${extensionBundleId("production")}`)
    fail("The signed widget extension identifier is not the production extension bundle ID under the app's team.");
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
  verifySignature(bundle);
  const signedEntitlements = (path) =>
    JSON.parse(
      tool("plutil", ["-convert", "json", "-o", "-", "-"], {
        input: tool("codesign", ["-d", "--entitlements", "-", "--xml", path]),
      }),
    );
  const { health, team } = checkSignedEntitlements(signedEntitlements(bundle));
  const plist = JSON.parse(tool("plutil", ["-convert", "json", "-o", "-", join(bundle, "Info.plist")]));
  checkInfoPlist(plist, "production");
  const binary = join(bundle, plist.CFBundleExecutable);
  const contents = (await files(bundle)).map((path) => relative(bundle, path));
  checkAppContents({ files: contents, code: (await readFile(binary)).toString("latin1") });
  const extension = join(bundle, "PlugIns/WorkoutActivityExtension.appex");
  checkSignedExtensionEntitlements(signedEntitlements(extension), team);
  checkExtensionInfoPlist(
    JSON.parse(tool("plutil", ["-convert", "json", "-o", "-", join(extension, "Info.plist")])),
    "production",
  );
  checkExtensionContents((await readFile(join(bundle, extensionBinary))).toString("latin1"));
  const configs = contents.filter((path) => path.endsWith("EXConstants.bundle/app.config"));
  if (configs.length !== 1) fail("The archive must embed exactly one app config.");
  checkEmbeddedConfig(JSON.parse(await readFile(join(bundle, configs[0]), "utf8")), oauth);
  return { health, version: plist.CFBundleShortVersionString, buildNumber: plist.CFBundleVersion };
}

/**
 * The text of a downloaded EAS build log. EAS stores logs Brotli-compressed
 * and serves them with `Content-Encoding: br`, which the runner's curl saves
 * as is. A log that is valid UTF-8 is read as text, since a short text prefix
 * such as `=` is also a complete Brotli stream; gzip and Brotli bytes are
 * decoded. A log that is none of these, or is cut short, contributes no text.
 */
export function logText(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return gunzipSync(bytes).toString("utf8");
    } catch {
      return "";
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Compressed bytes are not valid UTF-8.
  }
  try {
    return brotliDecompressSync(bytes).toString("utf8");
  } catch {
    return "";
  }
}

/** The build hook prints this line after checking the image's Xcode. */
export function checkXcodeLog(logs) {
  if (!logs.some((text) => text.includes(`Verified Xcode ${XCODE}.`)))
    fail(`The EAS build log does not show the Xcode ${XCODE} check.`);
}

/** At most this many builds of one commit are checked; `eas build:list` is asked for this many. */
export const buildListLimit = 50;

/**
 * The IDs of the commit's production iOS builds, from `eas build:list`.
 * Every listed build must be of that commit and profile, and a full page is
 * refused, since more builds could exist.
 */
export function commitBuildIds(builds, sha) {
  if (!Array.isArray(builds)) fail("EAS did not list the commit's builds.");
  if (builds.length >= buildListLimit) fail(`EAS lists ${buildListLimit} or more builds of ${sha}; check them in EAS.`);
  for (const build of builds)
    if (
      !isUuid(build?.id) ||
      build.gitCommitHash !== sha ||
      build.buildProfile !== "production" ||
      build.platform !== "IOS"
    )
      fail("EAS listed a build that is not a production iOS build of this commit.");
  return builds.map((build) => build.id);
}

/** A 200 reply's JSON body. A failure names `endpoint`, a fixed label, never the URL. */
async function getJsonOk(url, endpoint) {
  const reply = await getJson(url);
  if (reply.status !== 200) fail(`${endpoint} replied HTTP ${Number(reply.status)}.`);
  return reply.body;
}

/**
 * What a release reports when it finishes, each value checked: a known
 * status, a UUID build ID, and the version and build number in Apple's
 * format. It is the only build data a step logs or writes to the summary.
 */
export function summary(value) {
  const { status, buildId, version, buildNumber } = value ?? {};
  if (!releaseStatuses.has(status) || !isUuid(buildId) || !isBundleVersion(version) || !isBundleVersion(buildNumber))
    fail("The build summary holds a value that is not a release status, an EAS build ID or an app version.");
  return { status, buildId, version, buildNumber };
}

/**
 * Verifies the app's code signature, including nested code, before anything
 * inside it is trusted. codesign's output is discarded: a failure shows only
 * a fixed message.
 */
export function verifySignature(bundle, runTool = tool) {
  try {
    runTool("codesign", ["--verify", "--strict", "--deep", "--verbose=2", bundle], { timeout: 5 * MINUTE });
  } catch {
    fail("The app's code signature did not verify.");
  }
}

/**
 * The OAuth issuer and client that later workflow steps read from a private
 * file, from the production EAS environment, each checked to a strict pattern.
 */
export const oauthSettings = (envList) => checkOAuthSettings(parseEnvList(envList));

/** The OAuth issuer and client from the settings file, checked again. */
export function oauthFromFile(settings) {
  return checkOAuthSettings({
    FITNESS_OAUTH_ISSUER: settings?.issuer,
    FITNESS_OAUTH_CLIENT_ID: settings?.clientId,
  });
}

const readOAuthFile = async (found) =>
  oauthFromFile(await readResponse(required(found, "--oauth-file"), "The OAuth settings file"));

/**
 * The OAuth issuer and client from the admitting step's own shell
 * environment, which reads them from the settings file with `oauth-value`,
 * checked again. Admission sends them to Fitness and the issuer, so its
 * requests depend on no file this process reads.
 */
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
  checkProtectedResource(
    await getJsonOk(
      `${FITNESS_ORIGIN}/.well-known/oauth-protected-resource`,
      "Fitness production's protected-resource metadata",
    ),
    oauth.issuer,
  );
  await readiness(oauth.clientId);
  const metadata = await getJsonOk(
    `${oauth.issuer}/.well-known/oauth-authorization-server`,
    "The OAuth issuer's metadata",
  );
  checkAuthorizationServer(metadata, oauth.issuer);
  await checkClientAtIssuer({
    authorizationEndpoint: metadata.authorization_endpoint,
    issuer: oauth.issuer,
    clientId: oauth.clientId,
    redirectUri: `${bundleIds.production}://oauth`,
    resource: `${FITNESS_ORIGIN}/api/mcp`,
  });
}

const isId = (value) => Number.isSafeInteger(value) && value > 0;

/** The qualifications of one release must name the same Quality run at the same attempt. */
export function checkSameQuality(initial, current) {
  const ids = ["qualityRunId", "qualityAttempt"];
  if (
    !ids.every((id) => isId(initial?.[id])) ||
    initial.sha !== current?.sha ||
    ids.some((id) => initial[id] !== current[id])
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

/** A path curl writes to, which must be quoted safely in its config. */
const configPath = (path) =>
  /^\/[^\s"\\]+$/.test(path) ? path : fail("Download paths must be absolute, with no spaces, quotes or backslashes.");

/**
 * A curl config that downloads `url` to `output`. curl reads the URL from
 * this private file, so it never appears in a process list or a log.
 */
export function curlConfig(url, output) {
  return `url = "${downloadUrl(url)}"\noutput = "${configPath(output)}"\n`;
}

/**
 * Checks the finished EAS build this run started. Returns the curl configs
 * for the archive and logs, which hold the signed URLs, and what the archive
 * must match.
 */
export function buildDownloads(builds, { sha, projectId, directory }) {
  const build = checkBuild(builds, { sha, projectId });
  const archive = join(directory, "app.ipa");
  return {
    archive: curlConfig(build.artifacts.applicationArchiveUrl, archive),
    logs: (build.logFiles ?? []).map((url, index) => curlConfig(url, join(directory, "logs", `${index + 1}.txt`))),
    build: {
      buildId: build.id,
      version: isBundleVersion(build.appVersion) ? build.appVersion : fail("EAS reported a malformed app version."),
      buildNumber: isBundleVersion(build.appBuildVersion)
        ? build.appBuildVersion
        : fail("EAS reported a malformed build number."),
    },
  };
}

/**
 * The EAS GraphQL request for the submissions of each build, sent by curl in
 * a step with the Expo token. Each build is one aliased field, `b0`, `b1`...
 */
export function submissionsQuery(buildIds) {
  if (!Array.isArray(buildIds) || !buildIds.length || buildIds.length >= buildListLimit)
    fail("Pass between one and 49 EAS build IDs.");
  for (const id of buildIds) if (!isUuid(id)) fail("Pass EAS build IDs as UUIDs.");
  const names = buildIds.map((_, index) => `b${index}`);
  return {
    query: `query BuildSubmissions(${names.map((name) => `$${name}: ID!`).join(", ")}) { ${names
      .map((name) => `${name}: builds { byId(buildId: $${name}) { id submissions { id status } } }`)
      .join(" ")} }`,
    variables: Object.fromEntries(names.map((name, index) => [name, buildIds[index]])),
  };
}

/** Each build's submissions from the GraphQL reply, in the order asked. */
function submissionsOf(reply, buildIds) {
  if (reply?.errors?.length) fail("EAS could not list the builds' submissions.");
  return buildIds.map((id, index) => {
    const build = reply?.data?.[`b${index}`]?.byId;
    if (!build || build.id !== id || !Array.isArray(build.submissions))
      fail("EAS did not list the builds' submissions.");
    return build.submissions;
  });
}

/**
 * None of the builds may have a submission, whatever its status, so each
 * commit reaches App Store Connect at most once.
 */
export function checkNoSubmissions(reply, buildIds) {
  const submitted = submissionsOf(reply, buildIds)
    .map((submissions, index) => (submissions.length ? buildIds[index] : null))
    .filter(Boolean);
  if (submitted.length)
    fail(
      `This commit was already submitted, from EAS build ${submitted.join(", ")}. Check it in EAS and App Store Connect.`,
    );
}

/** The submission statuses EAS reports. */
const submissionStatuses = new Set(["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS", "FINISHED", "ERRORED", "CANCELED"]);

/** The one submission of the build this run submitted, as safe values: its ID and status. */
export function submissionStatus(reply, buildId) {
  const [submissions] = submissionsOf(reply, [buildId]);
  if (submissions.length !== 1) fail("EAS does not list exactly one submission of the build.");
  const [submission] = submissions;
  if (!isUuid(submission?.id) || !submissionStatuses.has(submission.status))
    fail("EAS reported a malformed submission.");
  return { submissionId: submission.id, status: submission.status };
}

/** Checks the downloaded archive and logs against the build, and returns the build's safe summary. */
async function verifyArchive({ archive, logsDir, build, oauth, workDir }) {
  const logs = [];
  for (const name of (await readdir(logsDir)).sort()) logs.push(logText(await readFile(join(logsDir, name))));
  checkXcodeLog(logs);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const artifact = await checkArchive(archive, workDir, oauth);
  if (!isBundleVersion(artifact.version) || !isBundleVersion(artifact.buildNumber))
    fail("The archive's version or build number is not in Apple's format.");
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

/**
 * Reads a JSON file another step wrote, often a provider's reply. A parse
 * error would quote the input, which can hold signed URLs or emails, so it
 * becomes a fixed message naming only the file's role.
 */
export async function readResponse(path, role) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${role} was not valid JSON.`);
  }
}
const readJson = (path) => readResponse(path, "The input file");
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const requireSha = (sha) => (SHA.test(sha ?? "") ? sha : fail("Pass the full 40-character commit SHA."));
const required = (found, name) => found[name] ?? fail(`Pass ${name}.`);

/** The builds to check: every listed production build of the commit, or the one build this run made. */
async function buildIdsFrom(found) {
  if (found["--build-list"])
    return commitBuildIds(await readResponse(found["--build-list"], "The EAS build list"), requireSha(found["--sha"]));
  if (isUuid(found["--build-id"])) return [found["--build-id"]];
  return fail("Pass --build-list and --sha, or --build-id.");
}

/** Exactly one match of `pattern` in `source`, or a failure naming `what`. */
function single(source, pattern, what) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) fail(`app.config.ts and src/config/variants.ts must name the ${what} once, as a literal.`);
  return matches[0];
}

/**
 * The EAS project metadata, read as text from the committed config without
 * running it: the project ID, slug and owner from app.config.ts, and the
 * production name and bundle ID from src/config/variants.ts.
 */
export function appConfigMetadata(appConfigSource, variantsSource) {
  const projectId = projectIdFrom(appConfigSource);
  const slug = single(appConfigSource, /^ {2}slug: "([a-z0-9-]{1,64})",$/gm, "EAS slug")[1];
  const owner = single(appConfigSource, /^ {2}owner: "([a-z0-9-]{1,64})",$/gm, "EAS owner")[1];
  const production = single(
    variantsSource,
    /^ {2}production: \{\n {4}name: "([A-Za-z0-9 ]{1,30})",\n {4}bundleIdentifier: "([a-z0-9.]{1,100})",\n {2}\},$/gm,
    "production variant",
  );
  if (production[2] !== bundleIds.production) fail(`The production bundle ID must be ${bundleIds.production}.`);
  return { projectId, slug, owner, name: production[1], bundleIdentifier: production[2] };
}

/**
 * The directory the EAS steps that hold the Expo token run in, apart from
 * `eas build`: a package.json with no dependencies or scripts, so the EAS CLI
 * never runs the workspace's Expo CLI, a static app.json with no plugins,
 * and the checked eas.json. Nothing in it runs code.
 */
export function staticEasFiles({ projectId, slug, owner, name, bundleIdentifier }, easJson) {
  return {
    "package.json": { name: "fitness-ios-eas-static", version: "0.0.0", private: true },
    "app.json": { expo: { name, slug, owner, ios: { bundleIdentifier }, extra: { eas: { projectId } } } },
    "eas.json": easJson,
  };
}

/** Writes the static EAS directory, private, with exactly its three files. */
export async function writeStaticEasDir(directory, metadata, easJson) {
  if (existsSync(directory) && (await readdir(directory)).length)
    fail("The static EAS directory must be new or empty.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(staticEasFiles(metadata, easJson)))
    await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

/** The pinned EAS CLI version and the EAS project, from the committed config. */
export async function configSummary(root = repoRoot) {
  checkNoEasIgnore(root);
  const easJson = await readJson(join(root, "apps/fitness-ios/eas.json"));
  const easCliVersion = checkEasJson(easJson);
  if (!/^\d+\.\d+\.\d+$/.test(easCliVersion)) fail("eas.json must pin an exact EAS CLI version.");
  const metadata = appConfigMetadata(
    await readFile(join(root, "apps/fitness-ios/app.config.ts"), "utf8"),
    await readFile(join(root, "apps/fitness-ios/src/config/variants.ts"), "utf8"),
  );
  return { easCliVersion, projectId: metadata.projectId, metadata, easJson };
}

const commands = {
  async "check-config"(argv) {
    const found = options(argv, { values: ["--out", "--static-dir"] });
    const { easCliVersion, projectId, metadata, easJson } = await configSummary();
    if (found["--static-dir"]) await writeStaticEasDir(resolve(found["--static-dir"]), metadata, easJson);
    const config = { easCliVersion, projectId };
    if (found["--out"]) await writeJson(found["--out"], config);
    console.log(JSON.stringify(config));
  },
  async "check-profile"(argv) {
    const found = options(argv, { values: ["--eas-package"] });
    checkIosBuild(await pinnedIosProfile(resolve(required(found, "--eas-package")), app));
    console.log("The production iOS profile is a Release store build of the production variant.");
  },
  async "oauth-env"(argv) {
    const found = options(argv, { values: ["--env-file", "--out"] });
    await writeJson(required(found, "--out"), oauthSettings(await readFile(required(found, "--env-file"), "utf8")));
    console.log("The production EAS environment names a well-formed OAuth issuer and client.");
  },
  async "oauth-value"(argv) {
    const found = options(argv, { values: ["--oauth-file", "--name"] });
    const name = ["issuer", "clientId"].includes(found["--name"])
      ? found["--name"]
      : fail("Pass --name issuer or clientId.");
    process.stdout.write(`${(await readOAuthFile(found))[name]}\n`);
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
    checkSameQuality(
      await readResponse(required(found, "--initial"), "The first release qualification"),
      await readResponse(required(found, "--current"), "The latest release qualification"),
    );
    console.log("The Quality run is unchanged.");
  },
  async "check-build"(argv) {
    const found = options(argv, { values: ["--sha", "--build-file", "--downloads-dir", "--out"] });
    const directory = resolve(required(found, "--downloads-dir"));
    const downloads = buildDownloads(await readResponse(required(found, "--build-file"), "The EAS build response"), {
      sha: requireSha(found["--sha"]),
      projectId: (await configSummary()).projectId,
      directory,
    });
    await mkdir(join(directory, "logs"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "archive.curlrc"), downloads.archive, { mode: 0o600 });
    for (const [index, config] of downloads.logs.entries())
      await writeFile(join(directory, `log-${index + 1}.curlrc`), config, { mode: 0o600 });
    await writeJson(required(found, "--out"), downloads.build);
    console.log(`EAS build ${downloads.build.buildId} is the finished production build of this commit.`);
  },
  async "submissions-query"(argv) {
    const found = options(argv, { values: ["--build-list", "--sha", "--build-id", "--out"] });
    const ids = await buildIdsFrom(found);
    // No builds means nothing to ask: the lookup step sees an empty file and sends no request.
    await writeFile(required(found, "--out"), ids.length ? `${JSON.stringify(submissionsQuery(ids))}\n` : "", {
      mode: 0o600,
    });
  },
  async "check-no-submissions"(argv) {
    const found = options(argv, { values: ["--build-list", "--sha", "--build-id", "--file"] });
    const ids = await buildIdsFrom(found);
    if (ids.length)
      checkNoSubmissions(await readResponse(required(found, "--file"), "The EAS submissions response"), ids);
    console.log(
      ids.length ? `None of the ${ids.length} builds checked has a submission.` : "No earlier build to check.",
    );
  },
  async "submission-status"(argv) {
    const found = options(argv, { values: ["--build-id", "--file"] });
    const buildId = isUuid(found["--build-id"]) ? found["--build-id"] : fail("Pass the EAS build ID.");
    const { submissionId, status } = submissionStatus(
      await readResponse(required(found, "--file"), "The EAS submissions response"),
      buildId,
    );
    console.log(`EAS submission ${submissionId} of build ${buildId}: ${status}.`);
    if (status !== "FINISHED") fail(`The submission is ${status}.`);
  },
  async "verify-archive"(argv) {
    const found = options(argv, {
      values: ["--archive", "--logs-dir", "--build", "--oauth-file", "--work-dir", "--out"],
    });
    const result = await verifyArchive({
      archive: resolve(required(found, "--archive")),
      logsDir: resolve(required(found, "--logs-dir")),
      build: await readResponse(required(found, "--build"), "The build summary"),
      oauth: await readOAuthFile(found),
      workDir: resolve(required(found, "--work-dir")),
    });
    await writeJson(required(found, "--out"), result);
    console.log(JSON.stringify(result));
  },
  async "build-id"(argv) {
    const found = options(argv, { values: ["--file"] });
    const { buildId } = await readResponse(required(found, "--file"), "The verified build summary");
    if (!isUuid(buildId)) fail("The verified build summary has no EAS build ID.");
    process.stdout.write(`${buildId}\n`);
  },
  async summary(argv) {
    const found = options(argv, { values: ["--file", "--sha", "--status"] });
    // The stored summary is checked before the status is replaced, and again after.
    const stored = summary(await readResponse(required(found, "--file"), "The verified build summary"));
    const status = found["--status"] ?? stored.status;
    process.stdout.write(summaryMarkdown({ ...stored, status }, requireSha(found["--sha"])));
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...argv] = process.argv.slice(2);
  try {
    const command = commands[name] ?? fail(`Run one of: ${Object.keys(commands).join(", ")}.`);
    await command(argv);
  } catch (error) {
    // Only this script's own messages are shown; anything else could quote a provider's reply.
    if (error instanceof ReleaseError) console.error(error.message);
    else {
      const code = /^E[A-Z]+$/.test(error?.code ?? "") ? ` (${error.code})` : "";
      console.error(`release-ios ${commands[name] ? name : "command"} failed unexpectedly${code}.`);
    }
    process.exitCode = 1;
  }
}
