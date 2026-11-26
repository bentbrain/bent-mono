/* global Bun */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppContents, checkHealthEntitlements, checkInfoPlist } from "../scripts/artifact.mjs";
import {
  admit,
  buildDownloads,
  oauthEnvironment,
  oauthFromEnvironment,
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
  checkNoEasBuilds,
  checkEasJson,
  checkEmbeddedConfig,
  checkOAuthSettings,
  checkPrivacyPage,
  checkProtectedResource,
  checkReadiness,
  checkSignedEntitlements,
  checkXcodeLog,
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
});

describe("release admission", () => {
  test("EAS must have no production build of the commit already", () => {
    expect(() => checkNoEasBuilds([], sha)).not.toThrow();
    expect(() => checkNoEasBuilds([{ ...build, gitCommitHash: "b".repeat(40) }], sha)).not.toThrow();
    for (const status of ["FINISHED", "ERRORED", "CANCELED", "IN_PROGRESS"])
      expect(() => checkNoEasBuilds([{ ...build, status }], sha)).toThrow(`${build.id} ${status}`);
    expect(() => checkNoEasBuilds({}, sha)).toThrow("did not list");
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
  const index = (pattern) => {
    const found = steps.findIndex((step) => pattern.test(`${step.name ?? ""} ${step.uses ?? ""} ${step.run ?? ""}`));
    expect(found).toBeGreaterThanOrEqual(0);
    return found;
  };

  test("runs only when dispatched on main in this repository, one release at a time", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
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
  });

  test("grants read permissions only", () => {
    expect(Object.values(workflow.permissions).every((level) => level === "read")).toBe(true);
    expect(job.permissions).toBeUndefined();
  });

  test("keeps the Expo token to the steps that run EAS", () => {
    expect(workflow.env).toBeUndefined();
    expect(job.env).toEqual({ RELEASE_SHA: "${{ github.sha }}" });
    const withToken = steps.filter((step) => step.env?.EXPO_TOKEN !== undefined);
    expect(withToken.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(Boolean(step.env?.EXPO_TOKEN)).toBe(runsEas(step));
      if (runsEas(step)) {
        expect(step.env.EXPO_TOKEN).toBe("${{ secrets.EXPO_TOKEN }}");
        expect(step["timeout-minutes"]).toBeGreaterThan(0);
        // EAS steps run the CLI and write to a file; they run no project code.
        expect(step.run).not.toMatch(/release-ios\.mjs|bun |npm /);
      }
    }
    // Installs and checks never see the token.
    for (const pattern of [
      /\.github\/actions\/setup/,
      /npm install/,
      /check-no-builds/,
      /verify-archive/,
      /oauth-env/,
      /release-ios\.mjs admit$/m,
    ])
      expect(steps[index(pattern)].env?.EXPO_TOKEN).toBeUndefined();
    expect(source.match(/secrets\./g)).toHaveLength(withToken.length);
  });

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

  test("uploads nothing and removes build files whatever happens", () => {
    expect(source).not.toMatch(/upload-artifact|actions\/cache/);
    const cleanup = steps.at(-1);
    expect(cleanup.if).toBe("always()");
    for (const path of ["ipa", "eas-build.json", "eas-existing.json", "eas-env-pre.txt", "eas-env-post.txt", "eas-cli"])
      expect(cleanup.run).toContain(`"$RUNNER_TEMP/${path}"`);
    // Only the build ID leaves a step; the summary has no URLs.
    expect(source.match(/GITHUB_OUTPUT/g)).toHaveLength(1);
    expect(steps[index(/verify-archive/)].run).toContain("build_id=");
    // Only the checked OAuth settings reach later steps' environment.
    expect(source.match(/GITHUB_ENV/g)).toHaveLength(1);
    expect(steps[index(/oauth-env/)].run).toContain('>> "$GITHUB_ENV"');
  });

  test("downloads the signed archive and logs with curl, never echoing their URLs", () => {
    const verify = steps[index(/verify-archive/)];
    expect(verify.run).toContain("check-build");
    expect(verify.run).toContain('"$(cat "$downloads/urls/archive-url")"');
    expect(verify.run).toContain('done < "$downloads/urls/log-urls"');
    expect(verify.run).not.toMatch(/set -x|echo "?\$url|echo "?\$\(cat/);
    const curls = verify.run.split("\n").filter((line) => /\bcurl -/.test(line));
    expect(curls).toHaveLength(2);
    for (const line of curls) {
      expect(line).toContain("--proto '=https'");
      expect(line).toContain("--max-time");
      expect(line).toContain("-fsS");
    }
  });

  test("qualifies, checks and admits in order around the build and the submission", () => {
    const qualify = index(/Qualify exact main source before installing/);
    const setup = index(/\.github\/actions\/setup/);
    const profile = index(/check-profile/);
    const handOff = index(/oauth-env --env-file "\$RUNNER_TEMP\/eas-env-pre.txt"/);
    const admitBuild = index(/release-ios\.mjs admit$/m);
    const requalify = index(/quality-build\.json/);
    const noBuilds = index(/check-no-builds/);
    const easBuild = index(/ build --profile production/);
    const verify = index(/verify-archive/);
    const readmit = index(/--current-env-file/);
    const submit = index(/ submit --profile production/);
    expect(qualify).toBeLessThan(setup);
    expect(setup).toBeLessThan(profile);
    expect(profile).toBeLessThan(handOff);
    expect(handOff).toBeLessThan(admitBuild);
    expect(admitBuild).toBeLessThan(requalify);
    expect(requalify).toBeLessThan(noBuilds);
    expect(noBuilds).toBeLessThan(easBuild);
    expect(easBuild).toBeLessThan(verify);
    expect(verify).toBeLessThan(readmit);
    expect(readmit).toBeLessThan(submit);
    expect(steps[readmit].run).toContain("--check-privacy");
    expect(steps[readmit].run).toContain("same-quality");
    expect(steps[submit].env.BUILD_ID).toBe("${{ steps.verify.outputs.build_id }}");
    expect(steps[easBuild]["timeout-minutes"]).toBe(150);
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
      "Run one of: check-config, check-profile, oauth-env, admit, same-quality, check-no-builds, check-build",
    );
  });

  test("check-config reads the pinned EAS CLI and the project, and refuses an .easignore", async () => {
    expect(await configSummary()).toEqual({ easCliVersion: "27.11.0", projectId });
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

  test("both qualifications must name the same Quality run", () => {
    const quality = { sha, qualityRunId: 23, qualityAttempt: 2, pullRequest: 2 };
    expect(() => checkSameQuality(quality, { ...quality })).not.toThrow();
    for (const change of [{ qualityRunId: 24 }, { qualityAttempt: 3 }, { sha: "b".repeat(40) }])
      expect(() => checkSameQuality(quality, { ...quality, ...change })).toThrow("changed");
    expect(() => checkSameQuality({}, {})).toThrow("changed");
  });

  test("check-no-builds reads the EAS build list", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-builds-"));
    try {
      const file = join(directory, "builds.json");
      writeFileSync(file, "[]");
      expect(run("check-no-builds", "--sha", sha, "--file", file).status).toBe(0);
      writeFileSync(file, JSON.stringify([build]));
      const refused = run("check-no-builds", "--sha", sha, "--file", file);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("already has a production build");
      expect(run("check-no-builds", "--sha", "abc", "--file", file).stderr).toContain("40-character");
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

  test("the OAuth settings handed to later steps are one variable a line, checked strictly", () => {
    const list = "FITNESS_OAUTH_ISSUER=https://clerk.example.com/\nFITNESS_OAUTH_CLIENT_ID=client_123\n";
    expect(oauthEnvironment(list)).toBe(
      "RELEASE_OAUTH_ISSUER=https://clerk.example.com\nRELEASE_OAUTH_CLIENT_ID=client_123\n",
    );
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
    expect(
      oauthFromEnvironment({ RELEASE_OAUTH_ISSUER: "https://clerk.example.com", RELEASE_OAUTH_CLIENT_ID: "c1" }),
    ).toEqual({ issuer: "https://clerk.example.com", clientId: "c1" });
    expect(() => oauthFromEnvironment({})).toThrow("FITNESS_OAUTH_ISSUER");
  });

  test("check-build writes the signed URLs to private files and prints none of them", () => {
    const signed = "https://storage.example.invalid/app.ipa?X-Signature=secret";
    const finished = { ...build, artifacts: { applicationArchiveUrl: signed }, logFiles: [`${signed}&log=1`] };
    expect(buildDownloads([finished], { sha, projectId })).toEqual({
      archive: signed,
      logs: [`${signed}&log=1`],
      build: { buildId: build.id, version: undefined, buildNumber: undefined },
    });
    for (const url of ["https://a.example/x y", "https://a.example/$(id)", 'https://a"b', "https://a.example/`id`"])
      expect(() =>
        buildDownloads([{ ...finished, artifacts: { applicationArchiveUrl: url } }], { sha, projectId }),
      ).toThrow("malformed download URL");
    expect(() => buildDownloads([{ ...finished, logFiles: ["https://a.example/log\nx"] }], { sha, projectId })).toThrow(
      "malformed download URL",
    );
    const directory = mkdtempSync(join(tmpdir(), "release-check-build-"));
    try {
      const file = join(directory, "build.json");
      writeFileSync(file, JSON.stringify([{ ...finished, appVersion: "1.0.0", appBuildVersion: "7" }]));
      const result = run(
        "check-build",
        "--sha",
        sha,
        "--build-file",
        file,
        "--downloads-dir",
        join(directory, "urls"),
        "--out",
        join(directory, "out.json"),
      );
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("storage.example.invalid");
      expect(readFileSync(join(directory, "urls/archive-url"), "utf8")).toBe(`${signed}\n`);
      expect(readFileSync(join(directory, "urls/log-urls"), "utf8")).toBe(`${signed}&log=1\n`);
      expect(JSON.parse(readFileSync(join(directory, "out.json"), "utf8"))).toEqual({
        buildId: build.id,
        version: "1.0.0",
        buildNumber: "7",
      });
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
