/* global Bun */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { checkAppContents, checkHealthEntitlements, checkInfoPlist } from "../scripts/artifact.mjs";
import { coverageArguments, swiftFilesFor } from "../scripts/codeql-coverage.mjs";
import { replayScope } from "../scripts/native.mjs";
import {
  admit,
  isBundleVersion,
  isUuid,
  knownCode,
  oauthErrorCodes,
  readinessCodes,
  verifySignature,
  appConfigMetadata,
  staticEasFiles,
  writeStaticEasDir,
  buildDownloads,
  checkNoSubmissions,
  curlConfig,
  submissionsQuery,
  oauthFromEnvironment,
  oauthFromFile,
  oauthSettings,
  checkAuthorizationServer,
  checkNoEasIgnore,
  checkSameQuality,
  configSummary,
  options,
  summaryMarkdown,
  checkBuild,
  carriesParameters,
  checkClientAtIssuer,
  checkIosBuild,
  commitBuildIds,
  submissionStatus,
  checkEasJson,
  checkEmbeddedConfig,
  checkOAuthSettings,
  checkPrivacyPage,
  checkProtectedResource,
  checkReadiness,
  checkSignedEntitlements,
  checkXcodeLog,
  logText,
  effectiveIosProfile,
  parseEnvList,
  projectIdFrom,
  resolveProfile,
  signInPage,
  summary,
} from "../scripts/release-ios.mjs";

const sha = "a".repeat(40);
const projectId = "50ba8677-0be0-45a5-ac8c-ceff89d65696";
const build = {
  id: "11111111-2222-4333-8444-555555555555",
  status: "FINISHED",
  platform: "IOS",
  buildProfile: "production",
  distribution: "STORE",
  isForIosSimulator: false,
  appIdentifier: "build.bent.fitness",
  gitCommitHash: sha,
  app: { id: projectId },
  artifacts: { applicationArchiveUrl: "https://example.invalid/app.ipa" },
};
const healthKit = {
  "com.apple.developer.healthkit": true,
  "com.apple.developer.healthkit.background-delivery": true,
};

describe("committed release settings", () => {
  const easJson = JSON.parse(readFileSync(new URL("../eas.json", import.meta.url), "utf8"));
  const appConfig = readFileSync(new URL("../app.config.ts", import.meta.url), "utf8");

  test("eas.json builds the production variant for the store on the pinned image and names the app", () => {
    expect(checkEasJson(easJson)).toBe("27.11.0");
    expect(() => checkEasJson({ ...easJson, submit: {} })).toThrow("App Store Connect app");
    expect(() => checkEasJson({ ...easJson, cli: { ...easJson.cli, requireCommit: false } })).toThrow("committed");
    const other = structuredClone(easJson);
    other.build.base.ios.image = "latest";
    expect(() => checkEasJson(other)).toThrow("macos-tahoe-26.5-xcode-26.6");
  });

  test("the effective iOS build, with the production profile's ios settings applied, must be the store build", () => {
    const withIos = (ios, common = {}) => {
      const changed = structuredClone(easJson);
      changed.build.production = {
        ...changed.build.production,
        ...common,
        ios: { ...changed.build.production.ios, ...ios },
      };
      return changed;
    };
    expect(() => checkEasJson(withIos({}))).not.toThrow();
    expect(() => checkEasJson(withIos({ image: "latest" }))).toThrow("macos-tahoe-26.5-xcode-26.6");
    for (const ios of [
      { environment: "development" },
      { distribution: "internal" },
      { env: { APP_VARIANT: "development" } },
      { simulator: true },
      { developmentClient: true },
      { buildConfiguration: "Debug" },
      { autoIncrement: false },
      { credentialsSource: "local" },
      { withoutCredentials: true },
      { enterpriseProvisioning: "adhoc" },
      { scheme: "Other" },
      { prebuildCommand: "echo" },
      { config: "custom.yml" },
      // eas-json converts these strings to booleans, so they count as set.
      { simulator: "true" },
      { developmentClient: "true" },
      { withoutCredentials: "true" },
      { simulator: "false" },
      { autoIncrement: "true" },
      { autoIncrement: "buildNumber" },
      { buildConfiguration: "release" },
      { image: ["macos-tahoe-26.5-xcode-26.6"] },
    ])
      expect(() => checkEasJson(withIos(ios))).toThrow("Release store build");
    expect(() =>
      checkEasJson(withIos({ simulator: false, developmentClient: false, withoutCredentials: false })),
    ).not.toThrow();
    expect(() => checkIosBuild({ ...effectiveIosProfile(easJson.build, "production"), simulator: true })).toThrow(
      "simulator must be absent or false",
    );
    expect(() => checkEasJson(withIos({}, { autoIncrement: undefined }))).toThrow("Release store build");
    expect(() => checkEasJson(withIos({ buildConfiguration: "Release" }))).not.toThrow();
    // ios env merges with the common env, as in EAS.
    expect(effectiveIosProfile(withIos({ env: { EXTRA: "1" } }).build, "production").env).toEqual({
      APP_VARIANT: "production",
      EXTRA: "1",
    });
  });

  test("build profiles resolve through extends as eas-json merges them", () => {
    const profiles = {
      root: { node: "24", ios: { image: "a", resourceClass: "m" }, env: { A: "1" } },
      base: { extends: "root", ios: { image: "b" }, env: { B: "2" } },
      production: { extends: "base", distribution: "store", env: { A: "3" } },
      loop: { extends: "loop" },
    };
    expect(resolveProfile(profiles, "production")).toEqual({
      node: "24",
      distribution: "store",
      ios: { image: "b", resourceClass: "m" },
      env: { A: "3", B: "2" },
    });
    expect(effectiveIosProfile(profiles, "production")).toEqual({
      node: "24",
      distribution: "store",
      credentialsSource: "remote",
      image: "b",
      resourceClass: "m",
      env: { A: "3", B: "2" },
    });
    expect(() => resolveProfile(profiles, "loop")).toThrow("cycle");
    expect(() => resolveProfile(profiles, "missing")).toThrow('"missing"');
  });

  test("app.config.ts names the EAS project", () => {
    expect(projectIdFrom(appConfig)).toBe(projectId);
    expect(() => projectIdFrom("export default {}")).toThrow("EAS project ID");
  });

  test("the EAS build hook checks the image's Xcode", () => {
    const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
    expect(scripts["eas-build-post-install"]).toBe("node scripts/native.mjs xcode 26.6");
    expect(() => checkXcodeLog(["Verified Xcode 26.5."])).toThrow("Xcode 26.6");
    expect(() => checkXcodeLog(["...", "Verified Xcode 26.6.\n"])).not.toThrow();
  });

  test("reads build logs that EAS serves compressed", () => {
    const log = "[INSTALL_DEPENDENCIES] Verified Xcode 26.6.\n";
    expect(logText(brotliCompressSync(Buffer.from(log)))).toBe(log);
    expect(logText(gzipSync(Buffer.from(log)))).toBe(log);
    expect(logText(Buffer.from(log))).toBe(log);
    const banner = "===== Starting build =====\nVerified Xcode 26.6.\n";
    expect(logText(Buffer.from(banner))).toBe(banner);
    expect(logText(Buffer.from([0xff, 0xfe, 0x00, 0x80]))).toBe("");
    const truncated = gzipSync(Buffer.from(log.repeat(100))).subarray(0, 40);
    expect(logText(truncated)).toBe("");
    expect(() => checkXcodeLog([logText(truncated), logText(brotliCompressSync(Buffer.from(log)))])).not.toThrow();
    expect(() => checkXcodeLog([logText(brotliCompressSync(Buffer.from(log)))])).not.toThrow();
  });
});

describe("release admission", () => {
  test("the commit's builds come from the EAS build list, all of this commit and profile", () => {
    expect(commitBuildIds([], sha)).toEqual([]);
    expect(commitBuildIds([build, { ...build, id: "22222222-2222-4333-8444-555555555555" }], sha)).toEqual([
      build.id,
      "22222222-2222-4333-8444-555555555555",
    ]);
    for (const change of [
      { gitCommitHash: "b".repeat(40) },
      { buildProfile: "preview" },
      { platform: "ANDROID" },
      { id: "x" },
    ])
      expect(() => commitBuildIds([{ ...build, ...change }], sha)).toThrow("not a production iOS build of this commit");
    expect(() =>
      commitBuildIds(
        Array.from({ length: 50 }, () => build),
        sha,
      ),
    ).toThrow("50 or more builds");
    expect(() => commitBuildIds({}, sha)).toThrow("did not list");
  });

  test("Fitness production must accept the build's OAuth client, and show that it checks clients", () => {
    const enabled = { status: 200, body: { enrollment: "enabled" } };
    const refused = { status: 403, body: { code: "client_not_allowed" } };
    expect(() => checkReadiness(enabled, refused)).not.toThrow();
    // A stale client in the EAS environment.
    expect(() => checkReadiness(refused, refused)).toThrow("client_not_allowed");
    expect(() => checkReadiness({ status: 503, body: { code: "enrollment_unavailable" } }, refused)).toThrow(
      "enrollment_unavailable",
    );
    // A deployment that ignores clientId accepts any client.
    expect(() => checkReadiness(enabled, enabled)).toThrow("does not check OAuth client IDs");
  });

  test("Fitness production names the build's issuer as its only authorization server", () => {
    const metadata = {
      resource: "https://fitness.bent.build/api/mcp",
      authorization_servers: ["https://clerk.example.com"],
    };
    expect(() => checkProtectedResource(metadata, "https://clerk.example.com")).not.toThrow();
    expect(() => checkProtectedResource(metadata, "https://clerk.other.example.com")).toThrow("another OAuth issuer");
    expect(() =>
      checkProtectedResource(
        { ...metadata, authorization_servers: [...metadata.authorization_servers, "x"] },
        "https://clerk.example.com",
      ),
    ).toThrow("another OAuth issuer");
    expect(() => checkProtectedResource({ ...metadata, resource: "x" }, "https://clerk.example.com")).toThrow(
      "another resource",
    );
  });

  test("the privacy policy must be served", () => {
    expect(() => checkPrivacyPage(200, "<h1>bent Fitness privacy</h1>")).not.toThrow();
    expect(() => checkPrivacyPage(200, "Account services need setup.")).toThrow("/privacy");
    expect(() => checkPrivacyPage(404, "")).toThrow("HTTP 404");
  });

  describe("Clerk's authorization flow", () => {
    const issuer = "https://clerk.example.com";
    const accounts = "https://accounts.example.com";
    const redirectUri = "build.bent.fitness://oauth";
    const request = {
      authorizationEndpoint: `${issuer}/oauth/authorize`,
      issuer,
      clientId: "client123",
      redirectUri,
      resource: "https://fitness.bent.build/api/mcp",
    };
    const signIn = (back) => `${accounts}/sign-in?redirect_url=${encodeURIComponent(back)}`;
    const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });
    /** Clerk's replies as its development instance gives them; each step can be replaced. */
    const clerk = ({ environment, first, second } = {}) => {
      const seen = [];
      const fetchImpl = async (url, init) => {
        const target = new URL(url);
        seen.push({ url: target, redirect: init.redirect });
        if (target.pathname === "/v1/environment")
          return environment ?? Response.json({ display_config: { sign_in_url: `${accounts}/sign-in` } });
        if (target.pathname === "/oauth/authorize")
          return first
            ? first(target)
            : redirect(signIn(`${issuer}/oauth/authorize-with-immediate-redirect?${target.searchParams}`));
        return second ? second(target) : redirect(signIn(`${accounts}/oauth-consent?${target.searchParams}`));
      };
      return { seen, fetchImpl };
    };

    test("accepts a known client whose request reaches the consent page unchanged", async () => {
      const known = clerk();
      await checkClientAtIssuer(request, known.fetchImpl);
      expect(known.seen.map((call) => call.url.pathname)).toEqual([
        "/v1/environment",
        "/oauth/authorize",
        "/oauth/authorize-with-immediate-redirect",
      ]);
      expect(known.seen.every((call) => call.redirect === "manual")).toBe(true);
      const first = known.seen[1].url.searchParams;
      expect(Object.fromEntries([...first].filter(([key]) => !["state", "code_challenge"].includes(key)))).toEqual({
        response_type: "code",
        client_id: "client123",
        redirect_uri: redirectUri,
        scope: "fitness:health:enroll openid",
        resource: "https://fitness.bent.build/api/mcp",
        code_challenge_method: "S256",
      });
      expect(first.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.get("state")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    test("accepts the production flow that continues on the issuer before sign-in", async () => {
      const direct = clerk({
        first: (target) => redirect(`${issuer}/oauth/authorize/continue?${target.searchParams}`),
      });
      await checkClientAtIssuer(request, direct.fetchImpl);
      expect(direct.seen.map((call) => call.url.pathname)).toEqual([
        "/v1/environment",
        "/oauth/authorize",
        "/oauth/authorize/continue",
      ]);
      const unknown = clerk({
        first: (target) => redirect(`${issuer}/oauth/authorize/continue?${target.searchParams}`),
        second: () => Response.json({ error: "invalid_client" }, { status: 401 }),
      });
      await expect(checkClientAtIssuer(request, unknown.fetchImpl)).rejects.toThrow("HTTP 401, invalid_client");
      const changed = clerk({
        first: (target) => {
          target.searchParams.set("scope", "openid");
          return redirect(`${issuer}/oauth/authorize/continue?${target.searchParams}`);
        },
      });
      await expect(checkClientAtIssuer(request, changed.fetchImpl)).rejects.toThrow("changed authorization parameters");
      const elsewhere = clerk({
        first: (target) =>
          redirect(`https://clerk.example.com.evil.example/oauth/authorize/continue?${target.searchParams}`),
      });
      await expect(checkClientAtIssuer(request, elsewhere.fetchImpl)).rejects.toThrow(
        "another page than the instance's sign-in",
      );
      const fragment = clerk({
        first: (target) => redirect(`${issuer}/oauth/authorize/continue?${target.searchParams}#`),
      });
      await expect(checkClientAtIssuer(request, fragment.fetchImpl)).rejects.toThrow(
        "changed authorization parameters",
      );
    });

    test("refuses the replies Clerk gives a client it does not accept", async () => {
      const unknown = clerk({ second: () => Response.json({ error: "invalid_client" }, { status: 401 }) });
      await expect(checkClientAtIssuer(request, unknown.fetchImpl)).rejects.toThrow("HTTP 401, invalid_client");
      const wrongRedirect = clerk({ second: () => Response.json({ error: "invalid_request" }, { status: 400 }) });
      await expect(checkClientAtIssuer(request, wrongRedirect.fetchImpl)).rejects.toThrow("invalid_request");
      const scope = clerk({ second: () => redirect(`${redirectUri}/?error=invalid_scope`, 303) });
      await expect(checkClientAtIssuer(request, scope.fetchImpl)).rejects.toThrow("invalid_scope");
    });

    test("refuses a first step that goes anywhere but the issuer's own check", async () => {
      // An HTTPS help page.
      const help = clerk({ first: () => redirect("https://help.example.com/oauth") });
      await expect(checkClientAtIssuer(request, help.fetchImpl)).rejects.toThrow("instance's sign-in");
      // The sign-in page returning to another issuer path or origin.
      for (const back of [
        (target) => `${issuer}/oauth/other?${target.searchParams}`,
        (target) =>
          `https://clerk.example.com.evil.example/oauth/authorize-with-immediate-redirect?${target.searchParams}`,
        (target) => `${accounts}/oauth-consent?${target.searchParams}`,
      ]) {
        const elsewhere = clerk({ first: (target) => redirect(signIn(back(target))) });
        await expect(checkClientAtIssuer(request, elsewhere.fetchImpl)).rejects.toThrow("returning to");
      }
      // A sign-in page on a look-alike host.
      const lookalike = clerk({
        first: (target) =>
          redirect(
            `https://accounts.example.com.evil.example/sign-in?redirect_url=${encodeURIComponent(`${issuer}/oauth/authorize-with-immediate-redirect?${target.searchParams}`)}`,
          ),
      });
      await expect(checkClientAtIssuer(request, lookalike.fetchImpl)).rejects.toThrow("instance's sign-in");
    });

    test("refuses a second step that ends at a generic sign-in page", async () => {
      for (const back of [`${accounts}/sign-in`, `${accounts}/default-redirect`, `${issuer}/oauth-consent`])
        await expect(
          checkClientAtIssuer(
            request,
            clerk({ second: (target) => redirect(signIn(`${back}?${target.searchParams}`)) }).fetchImpl,
          ),
        ).rejects.toThrow("returning to");
      // The sign-in page with no return, or with other parameters.
      await expect(
        checkClientAtIssuer(request, clerk({ second: () => redirect(`${accounts}/sign-in`) }).fetchImpl),
      ).rejects.toThrow("instance's sign-in");
      await expect(
        checkClientAtIssuer(
          request,
          clerk({
            second: (target) => redirect(`${signIn(`${accounts}/oauth-consent?${target.searchParams}`)}&after=x`),
          }).fetchImpl,
        ),
      ).rejects.toThrow("instance's sign-in");
    });

    test("refuses a continuation whose authorization parameters changed", async () => {
      const change = (target, name, value) => {
        const changed = new URLSearchParams(target.searchParams);
        if (value === undefined) changed.delete(name);
        else changed.set(name, value);
        return changed;
      };
      for (const [name, value] of [
        ["client_id", "other_client"],
        ["redirect_uri", "build.bent.fitness.dev://oauth"],
        ["scope", "openid"],
        ["state", "other"],
        ["resource", undefined],
      ]) {
        const second = clerk({
          second: (target) => redirect(signIn(`${accounts}/oauth-consent?${change(target, name, value)}`)),
        });
        await expect(checkClientAtIssuer(request, second.fetchImpl)).rejects.toThrow(
          "changed authorization parameters",
        );
        const first = clerk({
          first: (target) =>
            redirect(signIn(`${issuer}/oauth/authorize-with-immediate-redirect?${change(target, name, value)}`)),
        });
        await expect(checkClientAtIssuer(request, first.fetchImpl)).rejects.toThrow("changed authorization parameters");
      }
      const extra = clerk({
        second: (target) => redirect(signIn(`${accounts}/oauth-consent?${target.searchParams}&client_id=other`)),
      });
      await expect(checkClientAtIssuer(request, extra.fetchImpl)).rejects.toThrow("changed authorization parameters");
    });

    test("accepts only the five redirect statuses", async () => {
      for (const status of [301, 302, 303, 307, 308])
        await checkClientAtIssuer(
          request,
          clerk({ second: (target) => redirect(signIn(`${accounts}/oauth-consent?${target.searchParams}`), status) })
            .fetchImpl,
        );
      for (const status of [300, 304, 305, 306, 200])
        await expect(
          checkClientAtIssuer(
            request,
            clerk({
              first: (target) =>
                new Response(null, {
                  status,
                  headers: {
                    location: signIn(`${issuer}/oauth/authorize-with-immediate-redirect?${target.searchParams}`),
                  },
                }),
            }).fetchImpl,
          ),
        ).rejects.toThrow(`HTTP ${status}`);
    });

    test("refuses sign-in and continuation URLs with a fragment, user information or another port", async () => {
      const continuation = (target) => `${issuer}/oauth/authorize-with-immediate-redirect?${target.searchParams}`;
      for (const page of [
        "https://accounts.example.com/sign-in#x",
        "https://user@accounts.example.com/sign-in",
        "https://user:secret@accounts.example.com/sign-in",
        "https://accounts.example.com:8443/sign-in",
      ]) {
        const first = clerk({
          first: (target) =>
            redirect(
              `${page.split("#")[0]}?redirect_url=${encodeURIComponent(continuation(target))}${page.includes("#") ? "#x" : ""}`,
            ),
        });
        await expect(checkClientAtIssuer(request, first.fetchImpl)).rejects.toThrow("instance's sign-in");
      }
      for (const back of [
        (target) => `${continuation(target)}#fragment`,
        (target) => continuation(target).replace("https://", "https://user@"),
        (target) => continuation(target).replace("https://clerk.example.com", "https://clerk.example.com:8443"),
      ]) {
        const first = clerk({ first: (target) => redirect(signIn(back(target))) });
        await expect(checkClientAtIssuer(request, first.fetchImpl)).rejects.toThrow("returning to");
      }
      const consent = clerk({
        second: (target) => redirect(signIn(`${accounts}/oauth-consent?${target.searchParams}#done`)),
      });
      await expect(checkClientAtIssuer(request, consent.fetchImpl)).rejects.toThrow("returning to");
      for (const url of ["https://user@accounts.example.com/sign-in", "https://accounts.example.com:444/sign-in"])
        expect(() => signInPage({ display_config: { sign_in_url: url } })).toThrow("sign-in page");
    });

    test("refuses a bare trailing # anywhere in the flow", async () => {
      const continuation = (target) => `${issuer}/oauth/authorize-with-immediate-redirect?${target.searchParams}`;
      const consent = (target) => `${accounts}/oauth-consent?${target.searchParams}`;
      // The configured sign-in URL.
      expect(() => signInPage({ display_config: { sign_in_url: "https://accounts.example.com/sign-in#" } })).toThrow(
        "sign-in page",
      );
      const configured = clerk({
        environment: Response.json({ display_config: { sign_in_url: "https://accounts.example.com/sign-in#" } }),
      });
      await expect(checkClientAtIssuer(request, configured.fetchImpl)).rejects.toThrow("sign-in page");
      // The first and second sign-in redirects.
      const firstRedirect = clerk({ first: (target) => redirect(`${signIn(continuation(target))}#`) });
      await expect(checkClientAtIssuer(request, firstRedirect.fetchImpl)).rejects.toThrow("instance's sign-in");
      const secondRedirect = clerk({ second: (target) => redirect(`${signIn(consent(target))}#`) });
      await expect(checkClientAtIssuer(request, secondRedirect.fetchImpl)).rejects.toThrow("instance's sign-in");
      // The first and second return URLs.
      const firstReturn = clerk({ first: (target) => redirect(signIn(`${continuation(target)}#`)) });
      await expect(checkClientAtIssuer(request, firstReturn.fetchImpl)).rejects.toThrow("returning to");
      const secondReturn = clerk({ second: (target) => redirect(signIn(`${consent(target)}#`)) });
      await expect(checkClientAtIssuer(request, secondReturn.fetchImpl)).rejects.toThrow("returning to");
      // Without the "#", the same flow passes.
      await checkClientAtIssuer(request, clerk().fetchImpl);
    });

    test("takes the accounts host only from the instance's own sign-in URL", async () => {
      expect(signInPage({ display_config: { sign_in_url: "https://accounts.example.com/sign-in" } }).origin).toBe(
        accounts,
      );
      for (const url of [
        "http://accounts.example.com/sign-in",
        "https://accounts.example.com/login",
        "https://accounts.example.com/sign-in?x=1",
        "not a url",
        undefined,
      ])
        expect(() => signInPage({ display_config: { sign_in_url: url } })).toThrow("sign-in page");
      const unavailable = clerk({ environment: new Response("{}", { status: 404 }) });
      await expect(checkClientAtIssuer(request, unavailable.fetchImpl)).rejects.toThrow("environment replied HTTP 404");
      await expect(
        checkClientAtIssuer(
          { ...request, authorizationEndpoint: "https://other.example.com/oauth/authorize" },
          clerk().fetchImpl,
        ),
      ).rejects.toThrow("its own /oauth/authorize");
    });

    test("compares the eight authorization parameters exactly", () => {
      const expected = new URLSearchParams({
        client_id: "c",
        redirect_uri: "r",
        scope: "s",
        resource: "x",
        state: "t",
        code_challenge: "h",
        code_challenge_method: "S256",
        response_type: "code",
      });
      expect(carriesParameters(new URL(`https://a.example/?${expected}`), expected)).toBe(true);
      expect(carriesParameters(new URL(`https://a.example/?${expected}&state=t`), expected)).toBe(false);
      expect(carriesParameters(new URL(`https://a.example/?${expected}&prompt=none`), expected)).toBe(false);
    });
  });

  test("the release prints only its status, build, version and build number", () => {
    expect(
      summary({
        sha,
        status: "submitted",
        buildId: build.id,
        version: "1.0.0",
        buildNumber: "7",
        oauthClientId: "c",
        quality: {},
      }),
    ).toEqual({ status: "submitted", buildId: build.id, version: "1.0.0", buildNumber: "7" });
  });

  test("the production EAS environment carries the OAuth issuer and client", () => {
    const variables = parseEnvList(
      "\nEnvironment: production\n\u001b[1mFITNESS_OAUTH_ISSUER\u001b[22m=https://clerk.example.com/\nFITNESS_OAUTH_CLIENT_ID=client123\n",
    );
    expect(checkOAuthSettings(variables)).toEqual({ issuer: "https://clerk.example.com", clientId: "client123" });
    expect(() => checkOAuthSettings({ FITNESS_OAUTH_ISSUER: "https://clerk.example.com" })).toThrow(
      "FITNESS_OAUTH_CLIENT_ID",
    );
    expect(() =>
      checkOAuthSettings({ FITNESS_OAUTH_ISSUER: "http://clerk.example.com", FITNESS_OAUTH_CLIENT_ID: "c" }),
    ).toThrow("HTTPS");
  });

  test("the issuer must offer the enrollment scope with PKCE S256", () => {
    const metadata = {
      issuer: "https://clerk.example.com",
      scopes_supported: ["openid", "fitness:health:enroll"],
      code_challenge_methods_supported: ["S256"],
    };
    expect(() => checkAuthorizationServer(metadata, "https://clerk.example.com")).not.toThrow();
    expect(() =>
      checkAuthorizationServer({ ...metadata, scopes_supported: ["openid"] }, "https://clerk.example.com"),
    ).toThrow("fitness:health:enroll");
    expect(() => checkAuthorizationServer(metadata, "https://other.example.com")).toThrow("another issuer");
  });
});

describe("the built app", () => {
  test("the EAS build must be the finished production build of the exact commit", () => {
    expect(checkBuild([build], { sha, projectId })).toBe(build);
    for (const change of [
      { status: "ERRORED" },
      { gitCommitHash: "b".repeat(40) },
      { buildProfile: "development" },
      { appIdentifier: "build.bent.fitness.dev" },
      { isForIosSimulator: true },
      { app: { id: "00000000-0000-4000-8000-000000000000" } },
      { artifacts: {} },
    ])
      expect(() => checkBuild([{ ...build, ...change }], { sha, projectId })).toThrow(
        "not the finished production build",
      );
    expect(() => checkBuild([build, build], { sha, projectId })).toThrow("exactly one build");
  });

  test("the build embeds the production app config with the checked OAuth issuer and client", () => {
    const oauth = { issuer: "https://clerk.example.com", clientId: "client123" };
    const embedded = {
      ios: { bundleIdentifier: "build.bent.fitness" },
      extra: {
        variant: "production",
        fitnessOrigin: "https://fitness.bent.build",
        oauth: {
          ...oauth,
          redirectUri: "build.bent.fitness://oauth",
          resource: "https://fitness.bent.build/api/mcp",
          scopes: ["fitness:health:enroll", "openid"],
        },
      },
    };
    expect(() => checkEmbeddedConfig(embedded, oauth)).not.toThrow();
    for (const change of [
      { clientId: "client_stale" },
      { issuer: "https://clerk.other.example.com" },
      { redirectUri: "build.bent.fitness.dev://oauth" },
    ])
      expect(() =>
        checkEmbeddedConfig(
          { ...embedded, extra: { ...embedded.extra, oauth: { ...embedded.extra.oauth, ...change } } },
          oauth,
        ),
      ).toThrow("embedded app config");
    expect(() =>
      checkEmbeddedConfig({ ...embedded, extra: { ...embedded.extra, variant: "development" } }, oauth),
    ).toThrow("embedded app config");
  });

  test("the signed app has exactly the HealthKit entitlements and no debugging", () => {
    const signed = { ...healthKit, "application-identifier": "TEAM123456.build.bent.fitness", "get-task-allow": false };
    expect(checkSignedEntitlements(signed)).toEqual(Object.keys(healthKit));
    expect(() => checkSignedEntitlements({ ...signed, "get-task-allow": true })).toThrow("debugging");
    expect(() =>
      checkSignedEntitlements({ ...signed, "application-identifier": "TEAM123456.build.bent.fitness.dev" }),
    ).toThrow("production bundle ID");
    expect(() =>
      checkHealthEntitlements({ ...healthKit, "com.apple.developer.healthkit.access": ["health-records"] }),
    ).toThrow("Unexpected HealthKit");
  });

  test("the Info.plist reads Health data only, and the seeder stays out", () => {
    const plist = { CFBundleIdentifier: "build.bent.fitness", NSHealthShareUsageDescription: "Reads weigh-ins." };
    expect(() => checkInfoPlist(plist, "production")).not.toThrow();
    expect(() => checkInfoPlist({ ...plist, NSHealthUpdateUsageDescription: "x" }, "production")).toThrow("write");
    expect(() =>
      checkInfoPlist({ ...plist, NSAppTransportSecurity: { NSAllowsLocalNetworking: true } }, "production"),
    ).toThrow("local networking");
    expect(() => checkAppContents({ files: ["Info.plist"], code: "FitnessHealthModule" })).not.toThrow();
    expect(() => checkAppContents({ files: ["HealthSeed.bundle"], code: "FitnessHealthModule" })).toThrow("seeder");
    expect(() => checkAppContents({ files: [], code: "" })).toThrow("not linked");
  });
});

describe("the Deploy Fitness iOS workflow", () => {
  const source = readFileSync(new URL("../../../.github/workflows/deploy-fitness-ios.yml", import.meta.url), "utf8");
  const workflow = Bun.YAML.parse(source);
  const job = workflow.jobs.release;
  const steps = job.steps;
  const runsEas = (step) => /eas-cli\/bin\/run/.test(step.run ?? "");
  const callsExpo = (step) => /https:\/\/api\.expo\.dev\/graphql/.test(step.run ?? "");
  const index = (pattern) => {
    const found = steps.findIndex((step) => pattern.test(`${step.name ?? ""} ${step.uses ?? ""} ${step.run ?? ""}`));
    expect(found).toBeGreaterThanOrEqual(0);
    return found;
  };

  test("runs only when dispatched on main in this repository, one release at a time", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["sha"]);
    expect(workflow.on.workflow_dispatch.inputs.sha).toMatchObject({ required: true, type: "string" });
    expect(workflow.concurrency).toEqual({ group: "fitness-ios-production", "cancel-in-progress": false });
    expect(Object.keys(workflow.jobs)).toEqual(["release"]);
    for (const guard of [
      "github.repository == 'bentbrain/bent-mono'",
      "github.ref == 'refs/heads/main'",
      "github.event_name == 'workflow_dispatch'",
    ])
      expect(job.if).toContain(guard);
    expect(job.environment).toEqual({ name: "fitness-ios-production" });
    expect(job["runs-on"]).toBe("macos-26");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(240);
    // Every run builds from the checkout; no step runs only sometimes.
    for (const step of steps.slice(0, -1)) expect(step.if).toBeUndefined();
    expect(source).not.toMatch(/build_id ==|build_id !=|build:view|inputs\.build_id/);
  });

  test("grants read permissions only", () => {
    expect(Object.values(workflow.permissions).every((level) => level === "read")).toBe(true);
    expect(job.permissions).toBeUndefined();
  });

  test("keeps the Expo token to the steps that talk to EAS", () => {
    expect(workflow.env).toBeUndefined();
    expect(job.env).toEqual({ RELEASE_SHA: "${{ github.sha }}" });
    const withToken = steps.filter((step) => step.env?.EXPO_TOKEN !== undefined);
    expect(withToken).toHaveLength(8);
    for (const step of steps) {
      expect(Boolean(step.env?.EXPO_TOKEN)).toBe(runsEas(step) || callsExpo(step));
      if (step.env?.EXPO_TOKEN) {
        expect(step.env.EXPO_TOKEN).toBe("${{ secrets.EXPO_TOKEN }}");
        expect(step["timeout-minutes"]).toBeGreaterThan(0);
        // These steps run the EAS CLI or curl, and no project scripts or installs.
        expect(step.run).not.toMatch(/release-ios\.mjs|bun |npm /);
      }
    }
    // The GraphQL lookups read the token from stdin as a header line, never as curl config or an argument.
    const lookups = steps.filter(callsExpo);
    expect(lookups).toHaveLength(3);
    for (const lookup of lookups) {
      expect(lookup.run).toContain(`printf 'Authorization: Bearer %s\\n' "$EXPO_TOKEN" | curl -q --fail`);
      expect(lookup.run).toContain("--header @-");
      expect(lookup.run).toContain("2>/dev/null || status=$?");
      expect(lookup.run).not.toMatch(/--config|-K |-H "Authorization|--header "Authorization|header = /);
    }
    // Installs and checks never see the token.
    for (const pattern of [
      /\.github\/actions\/setup/,
      /npm install/,
      /check-no-submissions --build-list/,
      /check-no-submissions --build-id/,
      /verify-archive/,
      /oauth-env/,
      /node "\$checks" admit$/m,
      /submission-status/,
    ])
      expect(steps[index(pattern)].env?.EXPO_TOKEN).toBeUndefined();
    expect(source.match(/secrets\./g)).toHaveLength(withToken.length);
  });

  test("keeps every EAS CLI message in private files and shows only a fixed message", () => {
    const eas = steps.filter(runsEas);
    expect(eas.map((step) => step.name)).toEqual([
      "Read the production EAS environment",
      "List EAS builds of the commit",
      "Build on EAS",
      "Read the production EAS environment again",
      "Submit the build to TestFlight",
    ]);
    for (const step of eas) {
      expect(step.run).toContain("umask 077");
      expect(step.run).toMatch(
        /> "\$RUNNER_TEMP\/eas-[a-z-]+\.(json|txt|out)" 2> "\$RUNNER_TEMP\/eas-[a-z-]+\.err" \|\| status=\$\?/,
      );
      expect(step.run).toMatch(/echo "eas [a-z:]+ failed \(exit \$status\)\." >&2/);
    }
    const cleanup = steps.at(-1).run;
    for (const file of source.matchAll(/"\$RUNNER_TEMP\/(eas-[a-z-]+\.(?:err|out|txt|json))"/g))
      expect(cleanup).toContain(`"$RUNNER_TEMP/${file[1]}"`);
  });

  test("an EAS CLI failure shows no signed URL or email, only its exit code", () => {
    const root = mkdtempSync(join(tmpdir(), "release-eas-output-"));
    try {
      const bin = join(root, "eas-cli/node_modules/eas-cli/bin");
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, "eas-static"));
      const signed = "https://storage.example.invalid/archive.tar.gz?X-Amz-Signature=deadbeefcafe";
      const email = "owner@example.invalid";
      const fake = (code) =>
        `console.log(${JSON.stringify(`upload failed: ${signed}`)}); console.error(${JSON.stringify(
          `request to ${signed} failed; invited ${email}`,
        )}); process.exit(${code});`;
      for (const [code, visible] of [
        [1, /eas [a-z:]+ failed \(exit 1\)\./],
        [0, /^$/],
      ]) {
        writeFileSync(join(bin, "run"), fake(code));
        for (const step of steps.filter(runsEas)) {
          const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
            cwd: join(root, "eas-static"),
            encoding: "utf8",
            timeout: 30_000,
            env: {
              PATH: process.env.PATH,
              RUNNER_TEMP: root,
              RELEASE_SHA: sha,
              BUILD_ID: build.id,
              EXPO_TOKEN: "expo_synthetic_token",
            },
          });
          const shown = `${result.stdout}${result.stderr}`;
          expect({ step: step.name, status: result.status === 0 }).toEqual({ step: step.name, status: code === 0 });
          expect(shown.trim()).toMatch(visible);
          for (const secret of ["X-Amz-Signature", "storage.example.invalid", email, "expo_synthetic_token"])
            expect(shown).not.toContain(secret);
        }
      }
      // The captures hold the output, privately, for the steps that parse it.
      const capture = join(root, "eas-build.json");
      expect(readFileSync(capture, "utf8")).toContain("X-Amz-Signature");
      expect(statSync(capture).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "eas-build.err")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed EAS response goes from its capture to a parser that quotes none of it", () => {
    const root = mkdtempSync(join(tmpdir(), "release-capture-"));
    try {
      const bin = join(root, "eas-cli/node_modules/eas-cli/bin");
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, "eas-static"));
      const signed = "https://storage.example.invalid/archive.tar.gz?X-Amz-Signature=deadbeefcafe";
      const email = "owner@example.invalid";
      // Valid enough to look like JSON, but cut off: a parse error would quote it.
      writeFileSync(
        join(bin, "run"),
        `process.stdout.write(${JSON.stringify(`[{"id": "${signed}", "email": "${email}",`)}); process.exit(0);`,
      );
      const repo = new URL("../../../", import.meta.url).pathname;
      const env = { PATH: process.env.PATH, RUNNER_TEMP: root, RELEASE_SHA: sha, EXPO_TOKEN: "expo_synthetic_token" };
      const runStep = (step, cwd) =>
        spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
          cwd,
          env,
          encoding: "utf8",
          timeout: 60_000,
        });
      for (const [capture, parse, message] of [
        [/ build:list --platform ios/, /submissions-query --build-list/, "The EAS build list was not valid JSON."],
        [/ build --profile production/, /verify-archive/, "The EAS build response was not valid JSON."],
      ]) {
        const captured = runStep(steps[index(capture)], join(root, "eas-static"));
        expect(captured.status).toBe(0);
        const parsed = runStep(steps[index(parse)], repo);
        const shown = `${captured.stdout}${captured.stderr}${parsed.stdout}${parsed.stderr}`;
        expect(parsed.status).not.toBe(0);
        expect(parsed.stderr.trim()).toBe(message);
        for (const secret of ["X-Amz-Signature", "storage.example.invalid", email, "expo_synthetic_token"])
          expect(shown).not.toContain(secret);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("pins every action to a commit and never keeps checkout credentials", () => {
    for (const step of steps.filter((item) => item.uses)) {
      expect(step.uses).toMatch(/^(\.\/\.github\/actions\/[a-z-]+|[\w-]+\/[\w-]+@[0-9a-f]{40})$/);
      if (step.uses.startsWith("actions/checkout@")) expect(step.with["persist-credentials"]).toBe(false);
    }
    expect(steps.filter((step) => step.uses?.startsWith("actions/checkout@"))).toHaveLength(1);
  });

  test("passes inputs and outputs through env, never into scripts", () => {
    for (const step of steps) if (step.run) expect(step.run).not.toContain("${{");
    expect(steps[0].env).toEqual({ INPUT_SHA: "${{ inputs.sha }}" });
    expect(steps[0].run).toContain('"$INPUT_SHA" != "$RELEASE_SHA"');
  });

  test("uploads no GitHub Actions artifacts and removes build files whatever happens", () => {
    expect(source).not.toMatch(/upload-artifact|actions\/cache/);
    const cleanup = steps.at(-1);
    expect(cleanup.if).toBe("always()");
    for (const path of ["ipa", "eas-build.json", "eas-existing.json", "eas-submitted.json", "eas-cli", "eas-static"])
      expect(cleanup.run).toContain(`"$RUNNER_TEMP/${path}"`);
    // Only the build ID leaves a step as an output; nothing is written to the job's environment.
    expect(source.match(/GITHUB_OUTPUT/g)).toHaveLength(1);
    // The build ID is checked as a UUID before it is written.
    const verify = steps[index(/verify-archive/)].run;
    expect(verify).toContain('build_id="$(node "$checks" build-id --file "$RUNNER_TEMP/verified.json")"');
    expect(verify).toContain('echo "build_id=$build_id" >> "$GITHUB_OUTPUT"');
    expect(verify).not.toContain("node -p");
    expect(source).not.toContain("GITHUB_ENV");
    // The OAuth settings reach later steps as a private file, passed by path and removed at the end.
    expect(steps[index(/oauth-env/)].run).toContain('--out "$RUNNER_TEMP/oauth.json"');
    expect(steps[index(/verify-archive/)].run).toContain('--oauth-file "$RUNNER_TEMP/oauth.json"');
    expect(cleanup.run).toContain('"$RUNNER_TEMP/oauth.json"');
    // Each admission reads them from the file into its own shell, never a step's env block.
    const admissions = steps.filter((step) => /node "\$checks" admit\b/.test(step.run ?? ""));
    expect(admissions).toHaveLength(2);
    for (const step of admissions) {
      expect(step.run).toContain('oauth="$RUNNER_TEMP/oauth.json"');
      expect(step.run).toContain(
        'RELEASE_OAUTH_ISSUER="$(node "$checks" oauth-value --oauth-file "$oauth" --name issuer)"',
      );
      expect(step.run).toContain(
        'RELEASE_OAUTH_CLIENT_ID="$(node "$checks" oauth-value --oauth-file "$oauth" --name clientId)"',
      );
      expect(step.run).toContain("export RELEASE_OAUTH_ISSUER RELEASE_OAUTH_CLIENT_ID\n");
      expect(step.run.indexOf("export RELEASE_OAUTH")).toBeLessThan(step.run.indexOf('node "$checks" admit'));
    }
    expect(steps.filter((step) => /RELEASE_OAUTH/.test(step.run ?? ""))).toEqual(admissions);
    for (const step of steps) expect(JSON.stringify(step.env ?? {})).not.toContain("OAUTH");
  });

  test("downloads through curl configs, following HTTPS redirects only, and shows only curl's exit code", () => {
    const verify = steps[index(/verify-archive/)];
    expect(verify.run).toContain("check-build");
    const curl = verify.run.split("\n").find((line) => /\bcurl -/.test(line));
    expect(curl.trim().startsWith("curl -q ")).toBe(true);
    for (const flag of [
      "--fail",
      "--silent",
      "--location",
      "--max-redirs 5",
      "--proto '=https'",
      "--proto-redir '=https'",
      "--globoff",
    ])
      expect(curl).toContain(flag);
    expect(verify.run).toContain('--max-time "$2" --config "$1" 2>/dev/null');
    expect(verify.run).toContain('download "$downloads/archive.curlrc" 1200');
    expect(verify.run).toContain('for config in "$downloads"/log-*.curlrc; do');
    expect(verify.run).not.toMatch(/archive-url|log-urls|\$\(cat|set -x|echo "?\$url/);
    expect(verify.run).toContain('echo "The build archive could not be downloaded (curl exit $status)." >&2');
  });

  test("submits once without letting EAS set up TestFlight groups, then reports the submission's status", () => {
    const submit = steps[index(/ submit --profile production/)];
    expect(submit.run).toContain("--no-auto-testflight-setup");
    expect(submit.run).toContain('--id "$BUILD_ID"');
    expect(submit.env.BUILD_ID).toBe("${{ steps.verify.outputs.build_id }}");
    const report = index(/submission-status --build-id/);
    expect(report).toBeGreaterThan(index(/eas-submitted\.json" 2>\/dev\/null/));
    expect(index(/eas-submitted\.json" 2>\/dev\/null/)).toBeGreaterThan(index(/ submit --profile production/));
  });

  test("runs every EAS step that holds the token, except the build, from the static directory", () => {
    const easBuild = steps[index(/ build --profile production/)];
    const others = steps.filter((step) => runsEas(step) && step !== easBuild);
    expect(others).toHaveLength(4);
    for (const step of others) {
      expect(step["working-directory"]).toBe("${{ runner.temp }}/eas-static");
      expect(step.env).toMatchObject({
        EAS_NO_VCS: "1",
        EAS_PROJECT_ROOT: "${{ runner.temp }}/eas-static",
        EXPO_NO_DOTENV: "1",
      });
    }
    // The build is the only step with the token in the workspace.
    expect(steps.filter((step) => step.env?.EXPO_TOKEN && step["working-directory"] === "apps/fitness-ios")).toEqual([
      easBuild,
    ]);
    expect(easBuild.env).toMatchObject({ EXPO_NO_DOTENV: "1", EAS_SKIP_AUTO_FINGERPRINT: "1" });
    expect(easBuild.env.EAS_NO_VCS).toBeUndefined();
    // The workspace is installed only for the build, after the other pre-build EAS steps.
    const setup = index(/\.github\/actions\/setup/);
    expect(steps.filter((step) => step.uses === "./.github/actions/setup")).toHaveLength(1);
    expect(setup).toBeGreaterThan(index(/eas-env-pre\.err/));
    expect(setup).toBeGreaterThan(index(/ build:list --platform ios/));
    expect(setup).toBeLessThan(index(/ build --profile production/));
    expect(steps[index(/check-config/)].run).toContain('--static-dir "$RUNNER_TEMP/eas-static"');
    expect(steps.at(-1).run).toContain('"$RUNNER_TEMP/eas-static"');
  });

  test("every qualification requires Quality on the exact main commit and nothing else", () => {
    const calls = steps.filter((step) => /require-release-checks\.mjs/.test(step.run ?? ""));
    expect(calls).toHaveLength(3);
    for (const [position, output] of ["quality-initial", "quality-build", "quality-submit"].entries()) {
      expect(calls[position].run).toContain(
        `node scripts/require-release-checks.mjs --sha "$RELEASE_SHA" > "$RUNNER_TEMP/${output}.json"`,
      );
      expect(calls[position].env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    }
    expect(source.match(/require-release-checks\.mjs/g)).toHaveLength(3);
    // TestFlight releases do not wait for Fitness iOS Verification.
    expect(source).not.toContain("--ios");
    expect(source).not.toContain("fitness-ios-verify");
    expect(workflow.permissions.actions).toBe("read");
  });

  test("refuses a commit with a submitted build, and qualifies again immediately before each EAS change", () => {
    const qualify = index(/Qualify exact main source before installing/);
    const profile = index(/check-profile/);
    const handOff = index(/oauth-env --env-file "\$RUNNER_TEMP\/eas-env-pre.txt"/);
    const admitBuild = index(/node "\$checks" admit$/m);
    const list = index(/ build:list --platform ios/);
    const commitQuery = index(/submissions-query --build-list/);
    const commitLookup = index(/eas-existing-submissions\.json" 2>\/dev\/null/);
    const noSubmittedBuild = index(/check-no-submissions --build-list/);
    const setup = index(/\.github\/actions\/setup/);
    const clean = index(/Require a clean checkout/);
    const requalifyBuild = index(/quality-build\.json/);
    const easBuild = index(/ build --profile production/);
    const verify = index(/verify-archive/);
    const readmit = index(/--current-env-file/);
    const buildQuery = index(/submissions-query --build-id/);
    const buildLookup = index(/eas-build-submissions\.json" 2>\/dev\/null/);
    const noSubmission = index(/check-no-submissions --build-id/);
    const requalifySubmit = index(/quality-submit\.json/);
    const submit = index(/ submit --profile production/);
    const order = [
      qualify,
      profile,
      handOff,
      admitBuild,
      list,
      commitQuery,
      commitLookup,
      noSubmittedBuild,
      setup,
      clean,
      requalifyBuild,
      easBuild,
      verify,
      readmit,
      buildQuery,
      buildLookup,
      noSubmission,
      requalifySubmit,
      submit,
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // The qualification steps sit right before the EAS change they guard.
    expect(easBuild).toBe(requalifyBuild + 1);
    expect(submit).toBe(requalifySubmit + 1);
    for (const position of [requalifyBuild, requalifySubmit]) expect(steps[position].run).toContain("same-quality");
    expect(steps[readmit].run).toContain("--check-privacy");
    expect(steps[easBuild]["timeout-minutes"]).toBe(150);
    // A commit with no earlier build sends no lookup.
    expect(steps[commitLookup].run).toContain('if [[ ! -s "$RUNNER_TEMP/eas-existing-query.json" ]]; then');
    expect(steps[list].run).toContain("--limit 50");
  });
});

describe("the release subcommands", () => {
  const script = new URL("../scripts/release-ios.mjs", import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30_000 });

  test("read only the options each subcommand takes", () => {
    expect(options(["--sha", sha, "--check-privacy"], { values: ["--sha"], flags: ["--check-privacy"] })).toEqual({
      "--sha": sha,
      "--check-privacy": true,
    });
    expect(() => options(["--other", "x"], { values: ["--sha"] })).toThrow("Unexpected argument --other");
    expect(() => options(["--sha"], { values: ["--sha"] })).toThrow("Unexpected argument --sha");
    expect(() => options(["--sha", "a", "--sha", "b"], { values: ["--sha"] })).toThrow("Unexpected argument --sha");
    const unknown = run("credentials");
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain(
      "Run one of: check-config, check-profile, oauth-env, oauth-value, admit, same-quality, check-build, submissions-query",
    );
  });

  test("check-config reads the pinned EAS CLI and the project, and refuses an .easignore", async () => {
    expect(await configSummary()).toMatchObject({ easCliVersion: "27.11.0", projectId });
    const result = run("check-config");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ easCliVersion: "27.11.0", projectId });
    const root = mkdtempSync(join(tmpdir(), "release-easignore-"));
    try {
      expect(() => checkNoEasIgnore(root)).not.toThrow();
      writeFileSync(join(root, ".easignore"), "");
      expect(() => checkNoEasIgnore(root)).toThrow(".easignore");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the EAS project metadata is read from the config as text", async () => {
    const appConfig = readFileSync(new URL("../app.config.ts", import.meta.url), "utf8");
    const variants = readFileSync(new URL("../src/config/variants.ts", import.meta.url), "utf8");
    expect(appConfigMetadata(appConfig, variants)).toEqual({
      projectId,
      slug: "fitnessbentbuild",
      owner: "bentbuilds-team",
      name: "bent Fitness",
      bundleIdentifier: "build.bent.fitness",
    });
    expect(() => appConfigMetadata(appConfig.replace('  slug: "fitnessbentbuild",\n', ""), variants)).toThrow(
      "EAS slug",
    );
    expect(() =>
      appConfigMetadata(appConfig.replace('owner: "bentbuilds-team"', "owner: process.env.OWNER"), variants),
    ).toThrow("EAS owner");
    expect(() => appConfigMetadata(`${appConfig}\n  slug: "other",\n`, variants)).toThrow("EAS slug");
    expect(() =>
      appConfigMetadata(
        appConfig,
        variants.replace('bundleIdentifier: "build.bent.fitness",\n  },', 'bundleIdentifier: "build.other",\n  },'),
      ),
    ).toThrow("production bundle ID");
  });

  test("the static EAS directory gives the EAS CLI no code to run, even beside a poisoned workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-static-"));
    try {
      const { metadata, easJson } = await configSummary();
      const staticDir = join(root, "eas-static");
      await writeStaticEasDir(staticDir, metadata, easJson);
      await expect(writeStaticEasDir(staticDir, metadata, easJson)).rejects.toThrow("new or empty");
      expect(readdirSync(staticDir).sort()).toEqual(["app.json", "eas.json", "package.json"]);
      expect(statSync(staticDir).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(staticDir)) expect(statSync(join(staticDir, name)).mode & 0o777).toBe(0o600);
      const files = staticEasFiles(metadata, easJson);
      expect(JSON.parse(readFileSync(join(staticDir, "package.json"), "utf8"))).toEqual(files["package.json"]);
      expect(files["package.json"]).toEqual({ name: "fitness-ios-eas-static", version: "0.0.0", private: true });
      expect(JSON.parse(readFileSync(join(staticDir, "app.json"), "utf8"))).toEqual({
        expo: {
          name: "bent Fitness",
          slug: "fitnessbentbuild",
          owner: "bentbuilds-team",
          ios: { bundleIdentifier: "build.bent.fitness" },
          extra: { eas: { projectId } },
        },
      });
      expect(JSON.parse(readFileSync(join(staticDir, "eas.json"), "utf8"))).toEqual(easJson);

      // A decoy workspace beside it, where each config hook writes the token to a marker.
      const marker = join(root, "marker");
      const poison = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.env.EXPO_TOKEN));`;
      const decoy = join(root, "workspace");
      mkdirSync(join(decoy, "node_modules/expo/bin"), { recursive: true });
      writeFileSync(join(decoy, "package.json"), JSON.stringify({ name: "decoy", dependencies: { expo: "58.0.26" } }));
      writeFileSync(
        join(decoy, "node_modules/expo/package.json"),
        JSON.stringify({ name: "expo", version: "58.0.26" }),
      );
      writeFileSync(join(decoy, "node_modules/expo/bin/cli.js"), poison);
      writeFileSync(join(decoy, "plugin.js"), `${poison}\nmodule.exports = (config) => config;`);
      writeFileSync(
        join(decoy, "app.config.js"),
        `${poison}\nmodule.exports = { name: "decoy", slug: "decoy", plugins: ["./plugin.js"] };`,
      );
      writeFileSync(join(decoy, ".env"), "EXPO_PUBLIC_DECOY=1\n");

      const repoModules = new URL("../../../node_modules/", import.meta.url).pathname;
      const probe = join(root, "probe.cjs");
      writeFileSync(
        probe,
        `const { getConfig, getConfigFilePaths } = require(${JSON.stringify(join(repoModules, "@expo/config"))});
const resolveFrom = require(${JSON.stringify(join(repoModules, "resolve-from"))});
const dir = process.argv[2];
const result = {
  cli: resolveFrom.silent(dir, "expo/bin/cli") ?? null,
  paths: getConfigFilePaths(dir),
  exp: getConfig(dir, { skipSDKVersionRequirement: true }).exp,
};
process.stdout.write(JSON.stringify(result));`,
      );
      const inspect = (dir) =>
        spawnSync("node", [probe, dir], {
          cwd: dir,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            EXPO_TOKEN: "expo_synthetic_boundary_canary",
            EXPO_NO_DOTENV: "1",
            EAS_NO_VCS: "1",
          },
        });

      const result = inspect(staticDir);
      expect(result.status).toBe(0);
      const seen = JSON.parse(result.stdout);
      expect(seen.cli).toBeNull();
      expect(seen.paths.dynamicConfigPath).toBeNull();
      expect(seen.paths.staticConfigPath).toBe(join(staticDir, "app.json"));
      expect(seen.exp).toMatchObject({
        name: "bent Fitness",
        slug: "fitnessbentbuild",
        owner: "bentbuilds-team",
        ios: { bundleIdentifier: "build.bent.fitness" },
        extra: { eas: { projectId } },
      });
      expect(seen.exp.plugins).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain("DECOY");
      expect(existsSync(marker)).toBe(false);

      // The same probe on the decoy runs its config, so the marker would show a leak.
      inspect(decoy);
      expect(readFileSync(marker, "utf8")).toBe("expo_synthetic_boundary_canary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a malformed or hostile capture is refused without quoting it", () => {
    const signed = "https://storage.example.invalid/app.ipa?X-Amz-Signature=deadbeefcafe";
    const email = "owner@example.invalid";
    const directory = mkdtempSync(join(tmpdir(), "release-malformed-"));
    try {
      const file = (name, text) => {
        const path = join(directory, name);
        writeFileSync(path, text);
        return path;
      };
      const cut = file("cut.json", `{"url": "${signed}", "email": "${email}", `);
      // Valid JSON whose values are hostile: no message may echo them.
      const hostileBuild = file(
        "hostile-build.json",
        JSON.stringify([{ ...build, id: signed, gitCommitHash: email, artifacts: { applicationArchiveUrl: signed } }]),
      );
      const hostileList = file("hostile-list.json", JSON.stringify([{ ...build, id: signed, platform: email }]));
      const hostileReply = file(
        "hostile-reply.json",
        JSON.stringify({ errors: [{ message: `${signed} ${email}` }], data: { b0: { byId: { id: signed } } } }),
      );
      const hostileSubmission = file(
        "hostile-submission.json",
        JSON.stringify({ data: { b0: { byId: { id: build.id, submissions: [{ id: email, status: signed }] } } } }),
      );
      const out = join(directory, "out");
      const cases = [
        [
          ["check-build", "--sha", sha, "--build-file", cut, "--downloads-dir", out, "--out", out],
          "The EAS build response was not valid JSON.",
        ],
        [
          ["check-build", "--sha", sha, "--build-file", hostileBuild, "--downloads-dir", out, "--out", out],
          "not the finished production build",
        ],
        [
          ["submissions-query", "--build-list", cut, "--sha", sha, "--out", out],
          "The EAS build list was not valid JSON.",
        ],
        [["submissions-query", "--build-list", hostileList, "--sha", sha, "--out", out], "not a production iOS build"],
        [
          ["check-no-submissions", "--build-list", cut, "--sha", sha, "--file", cut],
          "The EAS build list was not valid JSON.",
        ],
        [
          ["check-no-submissions", "--build-id", build.id, "--file", cut],
          "The EAS submissions response was not valid JSON.",
        ],
        [["check-no-submissions", "--build-id", build.id, "--file", hostileReply], "could not list"],
        [
          ["submission-status", "--build-id", build.id, "--file", cut],
          "The EAS submissions response was not valid JSON.",
        ],
        [["submission-status", "--build-id", build.id, "--file", hostileSubmission], "malformed submission"],
        [["oauth-env", "--env-file", cut, "--out", out], "FITNESS_OAUTH_ISSUER"],
        [["build-id", "--file", cut], "The verified build summary was not valid JSON."],
        [["build-id", "--file", hostileList], "has no EAS build ID"],
        [
          ["summary", "--file", join(directory, "missing.json"), "--sha", sha],
          "release-ios summary failed unexpectedly (ENOENT).",
        ],
      ];
      for (const [args, message] of cases) {
        const result = run(...args);
        const shown = `${result.stdout}${result.stderr}`;
        expect({ args: args[0], failed: result.status !== 0 }).toEqual({ args: args[0], failed: true });
        expect(result.stderr).toContain(message);
        for (const secret of ["X-Amz-Signature", "storage.example.invalid", email, "at JSON.parse", "SyntaxError"])
          expect(shown).not.toContain(secret);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("build and submission IDs are strict UUID strings", () => {
    expect(isUuid(build.id)).toBe(true);
    expect(isUuid(build.id.toUpperCase())).toBe(true);
    for (const value of [
      "-".repeat(36),
      [build.id],
      `${build.id}\n`,
      ` ${build.id}`,
      build.id.slice(1),
      123,
      null,
      undefined,
    ])
      expect(isUuid(value)).toBe(false);
    expect(() => checkBuild([{ ...build, id: "-".repeat(36) }], { sha, projectId })).toThrow(
      "not the finished production build",
    );
    expect(() => checkBuild([{ ...build, id: [build.id] }], { sha, projectId })).toThrow(
      "not the finished production build",
    );
    expect(checkBuild([{ ...build, id: build.id.toUpperCase() }], { sha, projectId }).id).toBe(build.id.toUpperCase());
    expect(() => commitBuildIds([{ ...build, id: [build.id] }], sha)).toThrow("not a production iOS build");
    expect(() => submissionsQuery(["-".repeat(36)])).toThrow("UUIDs");
    const reply = (id) => ({ data: { b0: { byId: { id: build.id, submissions: [{ id, status: "FINISHED" }] } } } });
    expect(() => submissionStatus(reply([build.id]), build.id)).toThrow("malformed");
    expect(() => submissionStatus(reply("-".repeat(36)), build.id)).toThrow("malformed");
    expect(run("submission-status", "--build-id", "-".repeat(36), "--file", "/nonexistent").stderr).toContain(
      "Pass the EAS build ID.",
    );
  });

  test("provider error codes appear in messages only from each provider's known codes", () => {
    const refused = { status: 403, body: { code: "client_not_allowed" } };
    const notReady =
      /^Fitness production is not ready to enroll devices with this build's OAuth client \(HTTP 503\)\.$/;
    for (const code of [
      "https://storage.example.invalid/?X-Amz-Signature=x",
      "acct_7f3c2a9e_private",
      "owner@example.invalid",
      "invalid_client",
    ])
      expect(() => checkReadiness({ status: 503, body: { code } }, refused)).toThrow(notReady);
    expect(() => checkReadiness({ status: 503, body: { code: "enrollment_unavailable" } }, refused)).toThrow(
      "HTTP 503, enrollment_unavailable",
    );
    expect([...readinessCodes].sort()).toEqual([
      "client_not_allowed",
      "enrollment_unavailable",
      "invalid_request",
      "rate_limited",
    ]);
    expect([...oauthErrorCodes].sort()).toEqual([
      "access_denied",
      "invalid_client",
      "invalid_request",
      "invalid_scope",
      "server_error",
      "temporarily_unavailable",
      "unauthorized_client",
      "unsupported_response_type",
    ]);
    expect(knownCode(oauthErrorCodes, "invalid_scope")).toBe("invalid_scope");
    for (const code of ["acct_7f3c2a9e_private", "enrollment_unavailable", ["invalid_scope"], 1, undefined])
      expect(knownCode(oauthErrorCodes, code)).toBeNull();
  });

  test("Clerk errors outside the OAuth codes show only the HTTP status", async () => {
    const issuer = "https://clerk.example.com";
    const request = {
      authorizationEndpoint: `${issuer}/oauth/authorize`,
      issuer,
      clientId: "client123",
      redirectUri: "build.bent.fitness://oauth",
      resource: "https://fitness.bent.build/api/mcp",
    };
    const fetchWith = (second) => async (url) => {
      const target = new URL(url);
      if (target.pathname === "/v1/environment")
        return Response.json({ display_config: { sign_in_url: "https://accounts.example.com/sign-in" } });
      if (target.pathname === "/oauth/authorize")
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://accounts.example.com/sign-in?redirect_url=${encodeURIComponent(`${issuer}/oauth/authorize-with-immediate-redirect?${target.searchParams}`)}`,
          },
        });
      return second();
    };
    const failure = await checkClientAtIssuer(
      request,
      fetchWith(() => Response.json({ error: "acct_7f3c2a9e_private" }, { status: 401 })),
    ).catch((error) => error);
    expect(failure.message).toBe("Clerk does not accept the build's OAuth client for this app (HTTP 401).");
    const redirected = await checkClientAtIssuer(
      request,
      fetchWith(
        () =>
          new Response(null, {
            status: 303,
            headers: { location: "build.bent.fitness://oauth/?error=acct_7f3c2a9e_private" },
          }),
      ),
    ).catch((error) => error);
    expect(redirected.message).toBe(
      "Clerk does not accept the build's OAuth client for this app (redirected to the app).",
    );
    const known = await checkClientAtIssuer(
      request,
      fetchWith(() => Response.json({ error: "invalid_client" }, { status: 401 })),
    ).catch((error) => error);
    expect(known.message).toBe(
      "Clerk does not accept the build's OAuth client for this app (HTTP 401, invalid_client).",
    );
  });

  test("version and build number must be Apple's format before they reach a log or the summary", () => {
    for (const value of ["1.0.0", "7", "1", "26.6", "99999.99999.9999", "0.0.1"])
      expect(isBundleVersion(value)).toBe(true);
    for (const value of [
      "1.0.0.0",
      "v1.0",
      "+1",
      "-1",
      "1.0-beta",
      "1..0",
      "1.",
      "1234567",
      "999999.999999.999999",
      "1.0.0\n| injected | row |",
      "**bold**",
      "<img src=x onerror=alert(1)>",
      "owner@example.invalid",
      "https://storage.example.invalid/?X-Amz-Signature=x",
      " 1.0",
      7,
      ["1.0.0"],
      null,
    ])
      expect(isBundleVersion(value)).toBe(false);
    const good = { status: "submitted", buildId: build.id, version: "1.0.0", buildNumber: "7" };
    expect(summary(good)).toEqual(good);
    for (const change of [
      { version: "<b>1</b>" },
      { buildNumber: "7 | owner@example.invalid" },
      { version: "1.0.0".repeat(5) },
      { status: "**done**" },
      { buildId: "-".repeat(36) },
    ])
      expect(() => summary({ ...good, ...change })).toThrow("not a release status, an EAS build ID or an app version");
    expect(() =>
      buildDownloads([{ ...build, appVersion: "<b>1</b>", appBuildVersion: "7" }], {
        sha,
        projectId,
        directory: "/tmp/x",
      }),
    ).toThrow("malformed app version");
    expect(() =>
      buildDownloads([{ ...build, appVersion: "1.0.0", appBuildVersion: "7\n| x |" }], {
        sha,
        projectId,
        directory: "/tmp/x",
      }),
    ).toThrow("malformed build number");
    // The summary refuses a summary file holding an injected value.
    const directory = mkdtempSync(join(tmpdir(), "release-summary-version-"));
    try {
      const file = join(directory, "verified.json");
      writeFileSync(file, JSON.stringify({ ...good, version: "1.0.0 | <script>x</script>" }));
      const refused = run("summary", "--file", file, "--sha", sha, "--status", "submitted");
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).not.toContain("<script>");
      writeFileSync(file, JSON.stringify(good));
      expect(run("summary", "--file", file, "--sha", sha, "--status", "**hacked**").stderr).toContain(
        "not a release status",
      );
      // The stored status is checked before --status replaces it.
      writeFileSync(file, JSON.stringify({ ...good, status: "unexpected" }));
      const stored = run("summary", "--file", file, "--sha", sha, "--status", "submitted");
      expect(stored.status).not.toBe(0);
      expect(stored.stdout).toBe("");
      expect(stored.stderr).toContain("not a release status");
      writeFileSync(file, "null");
      expect(run("summary", "--file", file, "--sha", sha, "--status", "submitted").stderr).toContain(
        "not a release status",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the app's code signature is verified, nested code included, before anything in it is trusted", () => {
    const calls = [];
    verifySignature("/tmp/Payload/bentFitness.app", (command, args, options) => {
      calls.push({ command, args, options });
      return "";
    });
    expect(calls).toEqual([
      {
        command: "codesign",
        args: ["--verify", "--strict", "--deep", "--verbose=2", "/tmp/Payload/bentFitness.app"],
        options: { timeout: 300_000 },
      },
    ]);
    const failure = (() => {
      try {
        verifySignature("/tmp/Payload/bentFitness.app", () => {
          throw new Error(
            "a sealed resource is missing or invalid: https://storage.example.invalid/?X-Amz-Signature=x",
          );
        });
      } catch (error) {
        return error;
      }
    })();
    expect(failure.message).toBe("The app's code signature did not verify.");
    // The check runs on the archive before its entitlements are read.
    const source = readFileSync(new URL("../scripts/release-ios.mjs", import.meta.url), "utf8");
    const archive = source.slice(source.indexOf("async function checkArchive"));
    expect(archive.indexOf("verifySignature(bundle);")).toBeGreaterThan(0);
    expect(archive.indexOf("verifySignature(bundle);")).toBeLessThan(archive.indexOf('"--entitlements"'));
  });

  test("both qualifications must name the same Quality run at the same attempt", () => {
    const quality = { sha, qualityRunId: 23, qualityAttempt: 2, pullRequest: 2 };
    expect(() => checkSameQuality(quality, { ...quality })).not.toThrow();
    for (const change of [{ qualityRunId: 24 }, { qualityAttempt: 3 }, { sha: "b".repeat(40) }])
      expect(() => checkSameQuality(quality, { ...quality, ...change })).toThrow("changed");
    // A qualification with a missing or malformed Quality ID never matches.
    for (const id of ["qualityRunId", "qualityAttempt"])
      for (const value of [undefined, 0, -1, 1.5, "41", null, 2 ** 53]) {
        const bad = { ...quality, [id]: value };
        expect(() => checkSameQuality(bad, { ...bad })).toThrow("changed");
      }
    expect(() => checkSameQuality({}, {})).toThrow("changed");
  });

  test("submissions-query asks about every build of the commit, or none when there are none", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-builds-"));
    try {
      const list = join(directory, "builds.json");
      const out = join(directory, "query.json");
      writeFileSync(list, "[]");
      expect(run("submissions-query", "--build-list", list, "--sha", sha, "--out", out).status).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("");
      expect(
        run("check-no-submissions", "--build-list", list, "--sha", sha, "--file", join(directory, "none")).status,
      ).toBe(0);
      writeFileSync(list, JSON.stringify([build]));
      expect(run("submissions-query", "--build-list", list, "--sha", sha, "--out", out).status).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).variables).toEqual({ b0: build.id });
      const reply = join(directory, "reply.json");
      writeFileSync(
        reply,
        JSON.stringify({ data: { b0: { byId: { id: build.id, submissions: [{ id: "s", status: "FINISHED" }] } } } }),
      );
      const refused = run("check-no-submissions", "--build-list", list, "--sha", sha, "--file", reply);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("already submitted");
      expect(run("submissions-query", "--build-list", list, "--sha", "abc", "--out", out).stderr).toContain(
        "40-character",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("admit refuses OAuth settings that changed since the first admission, before any request", async () => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("no network in this test");
    };
    try {
      const oauth = { issuer: "https://clerk.example.com", clientId: "client_old" };
      const current = "FITNESS_OAUTH_ISSUER=https://clerk.example.com\nFITNESS_OAUTH_CLIENT_ID=client123\n";
      await expect(admit(oauth, current)).rejects.toThrow("changed during the release");
      await expect(admit(oauth, "FITNESS_OAUTH_ISSUER=https://clerk.example.com\n")).rejects.toThrow(
        "FITNESS_OAUTH_CLIENT_ID",
      );
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("the OAuth settings later steps read are written to a private file, and checked strictly on each read", () => {
    const list = "FITNESS_OAUTH_ISSUER=https://clerk.example.com/\nFITNESS_OAUTH_CLIENT_ID=client_123\n";
    expect(oauthSettings(list)).toEqual({ issuer: "https://clerk.example.com", clientId: "client_123" });
    for (const [issuer, clientId] of [
      ["https://clerk.example.com", "client\rOTHER=1"],
      ["https://clerk.example.com", "client 1"],
      ["https://clerk.example.com", "x".repeat(129)],
      ["https://clerk.example.com\rOTHER=1", "client"],
      ["https://clerk.example.com/path", "client"],
      ["https://user@clerk.example.com", "client"],
    ])
      expect(() => checkOAuthSettings({ FITNESS_OAUTH_ISSUER: issuer, FITNESS_OAUTH_CLIENT_ID: clientId })).toThrow(
        "FITNESS_OAUTH_",
      );
    expect(oauthFromFile({ issuer: "https://clerk.example.com", clientId: "c1" })).toEqual({
      issuer: "https://clerk.example.com",
      clientId: "c1",
    });
    for (const settings of [null, {}, [], { issuer: ["https://clerk.example.com"], clientId: "c1" }])
      expect(() => oauthFromFile(settings)).toThrow("FITNESS_OAUTH_ISSUER");
    expect(() => oauthFromFile({ issuer: "https://clerk.example.com/a?b", clientId: "c1" })).toThrow(
      "FITNESS_OAUTH_ISSUER must be an HTTPS origin.",
    );
    expect(
      oauthFromEnvironment({ RELEASE_OAUTH_ISSUER: "https://clerk.example.com", RELEASE_OAUTH_CLIENT_ID: "c1" }),
    ).toEqual({ issuer: "https://clerk.example.com", clientId: "c1" });
    expect(() => oauthFromEnvironment({})).toThrow("FITNESS_OAUTH_ISSUER");

    const directory = mkdtempSync(join(tmpdir(), "release-oauth-file-"));
    try {
      const envFile = join(directory, "env.txt");
      const out = join(directory, "oauth.json");
      writeFileSync(envFile, list);
      const written = run("oauth-env", "--env-file", envFile, "--out", out);
      expect(written.status).toBe(0);
      // The step log names neither value.
      expect(`${written.stdout}${written.stderr}`).not.toMatch(/clerk\.example\.com|client_123/);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        issuer: "https://clerk.example.com",
        clientId: "client_123",
      });
      expect(statSync(out).mode & 0o777).toBe(0o600);
      // Each value is read back on its own, checked again.
      expect(run("oauth-value", "--oauth-file", out, "--name", "issuer").stdout).toBe("https://clerk.example.com\n");
      expect(run("oauth-value", "--oauth-file", out, "--name", "clientId").stdout).toBe("client_123\n");
      expect(run("oauth-value", "--oauth-file", out, "--name", "constructor").stderr).toContain(
        "Pass --name issuer or clientId.",
      );
      // A tampered or unreadable settings file yields no value, and shows none.
      const tampered = join(directory, "tampered.json");
      for (const [contents, message] of [
        ["{not json user@example.com", "The OAuth settings file was not valid JSON."],
        [JSON.stringify({ issuer: "https://evil.example.com/x?user@example.com", clientId: "c1" }), "HTTPS origin"],
      ]) {
        writeFileSync(tampered, contents);
        const refused = run("oauth-value", "--oauth-file", tampered, "--name", "issuer");
        expect(refused.status).not.toBe(0);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toContain(message);
        expect(refused.stderr).not.toMatch(/user@example\.com|evil/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("check-build writes curl configs holding the signed URLs, and prints none of them", () => {
    const signed = "https://storage.example.invalid/app.ipa?X-Signature=secret";
    const finished = {
      ...build,
      artifacts: { applicationArchiveUrl: signed },
      logFiles: [`${signed}&log=1`],
      appVersion: "1.0.0",
      appBuildVersion: "7",
    };
    const options_ = { sha, projectId, directory: "/runner/temp/ipa" };
    expect(buildDownloads([finished], options_)).toEqual({
      archive: `url = "${signed}"\noutput = "/runner/temp/ipa/app.ipa"\n`,
      logs: [`url = "${signed}&log=1"\noutput = "/runner/temp/ipa/logs/1.txt"\n`],
      build: { buildId: build.id, version: "1.0.0", buildNumber: "7" },
    });
    // eas build --json reports a list of one build.
    expect(() => buildDownloads(finished, options_)).toThrow("exactly one build");
    expect(() => buildDownloads([{ ...finished, gitCommitHash: "b".repeat(40) }], options_)).toThrow(
      "not the finished production build",
    );
    for (const url of [
      "https://a.example/x y",
      "https://a.example/$(id)",
      'https://a"b',
      "https://a.example/`id`",
      "https://a.example/a\\b",
    ])
      expect(() => curlConfig(url, "/tmp/out")).toThrow("malformed download URL");
    expect(() => curlConfig("https://a.example/log\nurl = https://other", "/tmp/out")).toThrow(
      "malformed download URL",
    );
    for (const path of ["relative/out", "/tmp/a b", '/tmp/a"b', "/tmp/a\\b"])
      expect(() => curlConfig(signed, path)).toThrow("Download paths");
    const directory = mkdtempSync(join(tmpdir(), "release-check-build-"));
    try {
      const file = join(directory, "build.json");
      writeFileSync(file, JSON.stringify([finished]));
      const downloads = join(directory, "ipa");
      const result = run(
        "check-build",
        "--sha",
        sha,
        "--build-file",
        file,
        "--downloads-dir",
        downloads,
        "--out",
        join(directory, "out.json"),
      );
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("storage.example.invalid");
      expect(readFileSync(join(downloads, "archive.curlrc"), "utf8")).toBe(
        `url = "${signed}"\noutput = "${join(downloads, "app.ipa")}"\n`,
      );
      expect(readFileSync(join(downloads, "log-1.curlrc"), "utf8")).toContain(`url = "${signed}&log=1"`);
      expect(JSON.parse(readFileSync(join(directory, "out.json"), "utf8"))).toEqual({
        buildId: build.id,
        version: "1.0.0",
        buildNumber: "7",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("asks EAS for each build's submissions and refuses any submitted build", () => {
    const second = "22222222-2222-4333-8444-555555555555";
    expect(submissionsQuery([build.id, second])).toEqual({
      query:
        "query BuildSubmissions($b0: ID!, $b1: ID!) { b0: builds { byId(buildId: $b0) { id submissions { id status } } } b1: builds { byId(buildId: $b1) { id submissions { id status } } } }",
      variables: { b0: build.id, b1: second },
    });
    expect(() => submissionsQuery([])).toThrow("between one and 49");
    expect(() => submissionsQuery(["abc"])).toThrow("UUIDs");
    expect(() => submissionsQuery(Array.from({ length: 50 }, () => build.id))).toThrow("between one and 49");
    const reply = (...builds) => ({
      data: Object.fromEntries(builds.map(([id, submissions], index) => [`b${index}`, { byId: { id, submissions } }])),
    });
    expect(() => checkNoSubmissions(reply([build.id, []], [second, []]), [build.id, second])).not.toThrow();
    for (const status of ["FINISHED", "ERRORED", "CANCELED", "IN_PROGRESS"])
      expect(() =>
        checkNoSubmissions(reply([build.id, []], [second, [{ id: "s1", status }]]), [build.id, second]),
      ).toThrow(`already submitted, from EAS build ${second}`);
    expect(() => checkNoSubmissions(reply(["other", []]), [build.id])).toThrow("did not list");
    expect(() => checkNoSubmissions(reply([build.id, []]), [build.id, second])).toThrow("did not list");
    expect(() => checkNoSubmissions({ errors: [{ message: "Unauthorized" }] }, [build.id])).toThrow("could not list");
    expect(() => checkNoSubmissions({}, [build.id])).toThrow("did not list");
  });

  test("reports the build's one submission as a validated ID and status", () => {
    const submission = "33333333-3333-4333-8444-555555555555";
    const reply = (submissions) => ({ data: { b0: { byId: { id: build.id, submissions } } } });
    expect(submissionStatus(reply([{ id: submission, status: "FINISHED" }]), build.id)).toEqual({
      submissionId: submission,
      status: "FINISHED",
    });
    expect(() => submissionStatus(reply([]), build.id)).toThrow("exactly one submission");
    expect(() => submissionStatus(reply([{ id: "x", status: "FINISHED" }]), build.id)).toThrow("malformed");
    expect(() =>
      submissionStatus(reply([{ id: submission, status: "FINISHED https://storage.example.invalid" }]), build.id),
    ).toThrow("malformed");
    const directory = mkdtempSync(join(tmpdir(), "release-submission-"));
    try {
      const file = join(directory, "reply.json");
      writeFileSync(file, JSON.stringify(reply([{ id: submission, status: "FINISHED" }])));
      const done = run("submission-status", "--build-id", build.id, "--file", file);
      expect(done.status).toBe(0);
      expect(done.stdout).toBe(`EAS submission ${submission} of build ${build.id}: FINISHED.\n`);
      writeFileSync(file, JSON.stringify(reply([{ id: submission, status: "ERRORED" }])));
      expect(run("submission-status", "--build-id", build.id, "--file", file).status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the summary names the status, commit, build, version and build number, and nothing else", () => {
    const markdown = summaryMarkdown(
      { status: "submitted", buildId: build.id, version: "1.0.0", buildNumber: "7", url: "https://example.invalid/x" },
      sha,
    );
    expect(markdown).toContain(`| submitted | \`${sha}\` | \`${build.id}\` | 1.0.0 | 7 |`);
    expect(markdown).not.toContain("https://");
    const directory = mkdtempSync(join(tmpdir(), "release-summary-"));
    try {
      const file = join(directory, "verified.json");
      writeFileSync(file, JSON.stringify({ status: "built", buildId: build.id, version: "1.0.0", buildNumber: "7" }));
      const result = run("summary", "--file", file, "--sha", sha, "--status", "submitted");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("| submitted |");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the CodeQL Swift scopes", () => {
  const tracked = [
    "apps/fitness-ios/modules/fitness-health/ios/Package.swift",
    "apps/fitness-ios/modules/fitness-health/ios/Core/Sync.swift",
    "apps/fitness-ios/modules/fitness-health/ios/Platform/HealthStore.swift",
    "apps/fitness-ios/modules/fitness-health/ios/Module/FitnessHealthModule.swift",
    "apps/fitness-ios/modules/fitness-health/ios/Tests/SyncTests.swift",
    "apps/fitness-ios/tools/health-seed/HealthSeed/Seeder.swift",
    "apps/fitness-ios/tools/health-seed/SimulatorFlows/SyncFlowTests.swift",
    "",
  ];

  test("split the tracked Swift into the app and the tools, with the module's core in both", () => {
    expect(swiftFilesFor("app", tracked)).toEqual(tracked.slice(1, 4));
    // The tools scope is the seeder with its UI tests and the module's Core and Tests.
    expect(swiftFilesFor("tools", tracked)).toEqual([tracked[1], ...tracked.slice(4, 7)]);
    expect(swiftFilesFor("all", tracked)).toEqual(tracked.slice(1, 7));
    // Together the two CodeQL jobs' scopes cover every tracked Swift source.
    const covered = new Set(["app", "tools"].flatMap((scope) => swiftFilesFor(scope, tracked)));
    expect([...covered].sort()).toEqual(swiftFilesFor("all", tracked).sort());
  });

  test("fail closed for a tracked Swift file outside both scopes", () => {
    for (const outside of [
      "apps/fitness-ios/modules/fitness-health/ios/Extra/New.swift",
      "apps/fitness-ios/ios/Generated.swift",
      "apps/other/Tool.swift",
      "Root.swift",
    ])
      for (const scope of ["all", "app", "tools"])
        expect(() => swiftFilesFor(scope, [...tracked, outside])).toThrow(outside);
    expect(() => swiftFilesFor("app", tracked.slice(4))).toThrow("No tracked Swift files");
    expect(() => swiftFilesFor("tools", tracked.slice(2, 4))).toThrow("No tracked Swift files");
  });

  test("every tracked Swift file in the repository is in a scope", () => {
    const listed = spawnSync("git", ["ls-files", "-z", "*.swift"], {
      cwd: new URL("../../..", import.meta.url).pathname,
      encoding: "utf8",
    }).stdout.split("\0");
    expect(swiftFilesFor("all", listed).length).toBeGreaterThan(20);
    for (const scope of ["app", "tools"]) expect(swiftFilesFor(scope, listed).length).toBeGreaterThan(0);
    const covered = new Set(["app", "tools"].flatMap((scope) => swiftFilesFor(scope, listed)));
    expect([...covered].sort()).toEqual(swiftFilesFor("all", listed).sort());
  });

  test("read a scope and require derived data for the app and all scopes only", () => {
    expect(coverageArguments(["db", "derived"])).toEqual({ scope: "all", database: "db", derived: "derived" });
    expect(coverageArguments(["--scope", "app", "db", "derived"])).toEqual({
      scope: "app",
      database: "db",
      derived: "derived",
    });
    expect(coverageArguments(["--scope", "tools", "db"])).toEqual({
      scope: "tools",
      database: "db",
      derived: undefined,
    });
    for (const args of [
      [],
      ["db"],
      ["--scope", "app", "db"],
      ["--scope", "all", "db"],
      ["--scope", "tools", "db", "derived"],
      ["--scope", "seeder", "db"],
      ["--scope", "core", "db"],
      ["--scope", "Tools", "db"],
      ["--scope"],
      ["db", "derived", "extra"],
    ])
      expect(() => coverageArguments(args)).toThrow("Usage");
    const script = new URL("../scripts/codeql-coverage.mjs", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [script, "--scope", "tools"], { encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage");
  });

  test("replay-swift compiles all targets by default, or the app's or the seeder's", () => {
    expect(replayScope([])).toBe("all");
    for (const scope of ["all", "app", "seeder"]) expect(replayScope([scope])).toBe(scope);
    for (const args of [["tools"], ["App"], ["app", "seeder"], [""]]) expect(() => replayScope(args)).toThrow("scope");
    const source = readFileSync(new URL("../scripts/native.mjs", import.meta.url), "utf8");
    const replay = source.slice(source.indexOf('"replay-swift"(args)'), source.indexOf('"core-build"()'));
    // The seeder scope reads only the seeder build, so it needs no prebuilt app project.
    expect(replay).toContain(
      'if (scope !== "seeder") builds.push({ log: "app-build.log", targets: ["FitnessHealth", project()] });',
    );
    expect(replay).toContain(
      'if (scope !== "app") builds.push({ log: "seeder-build.log", targets: ["HealthSeed", "SimulatorFlows"] });',
    );
  });
});
