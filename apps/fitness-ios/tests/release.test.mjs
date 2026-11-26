import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkAppContents, checkHealthEntitlements, checkInfoPlist } from "../scripts/artifact.mjs";
import {
  checkAuthorizationServer,
  checkBuild,
  checkEasJson,
  checkEmbeddedConfig,
  checkOAuthSettings,
  checkPriorAttempts,
  checkPrivacyPage,
  checkProtectedResource,
  checkReadiness,
  checkSignedEntitlements,
  checkXcodeLog,
  childEnvironment,
  easEnvironment,
  parseArgs,
  parseEnvList,
  projectIdFrom,
  redact,
  redactingWriter,
  resolveProfile,
  secretsFrom,
  stream,
  unsafeDebugVariables,
  validateConfig,
} from "../scripts/release-ios.mjs";

const sha = "a".repeat(40);
const projectId = "50ba8677-0be0-45a5-ac8c-ceff89d65696";
const config = {
  ascKeyPath: "/private/release/AuthKey.p8",
  ascKeyId: "ABCDE12345",
  ascIssuerId: "00000000-0000-4000-8000-000000000000",
  appleTeamId: "TEAM123456",
  appleTeamType: "INDIVIDUAL",
  expoTokenPath: "/private/release/expo-token",
  workDir: "/private/release/work",
};
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

describe("release arguments and configuration", () => {
  test("build needs a full SHA and an absolute private config", () => {
    expect(parseArgs(["build", "--sha", sha, "--config", "/private/release.json"])).toEqual({
      action: "build",
      sha,
      configPath: "/private/release.json",
    });
    expect(() => parseArgs(["build", "--sha", "abc", "--config", "/private/release.json"])).toThrow("Usage");
    expect(() => parseArgs(["build", "--sha", sha, "--config", "release.json"])).toThrow("Usage");
    expect(() => parseArgs(["build", "--sha", sha, "--sha", sha, "--config", "/x"])).toThrow("Usage");
    expect(() => parseArgs(["update", "--config", "/x"])).toThrow("Usage");
    expect(parseArgs(["credentials", "--config", "/x"]).action).toBe("credentials");
    expect(() => parseArgs(["credentials", "--sha", sha, "--config", "/x"])).toThrow("Usage");
  });

  test("the configuration names the team key, the Apple team and a work directory outside the checkout", () => {
    expect(validateConfig(config).workDir).toBe("/private/release/work");
    expect(() => validateConfig({ ...config, ascKeyId: "short" })).toThrow("ascKeyPath");
    expect(() => validateConfig({ ...config, appleTeamType: "IN_HOUSE" })).toThrow("ascKeyPath");
    expect(() => validateConfig({ ...config, expoTokenPath: "token" })).toThrow("ascKeyPath");
    const inside = new URL("..", import.meta.url).pathname;
    expect(() => validateConfig({ ...config, workDir: inside })).toThrow("outside the source checkout");
  });

  test("EAS gets the allowlisted environment, the Expo token and the App Store Connect key, and nothing else", () => {
    const shell = {
      PATH: "/bin",
      HOME: "/home/example",
      GH_TOKEN: "gh",
      VERCEL_TOKEN: "v",
      NODE_DEBUG: "child_process",
      NODE_OPTIONS: "--require ./trace.js",
      AWS_SECRET_ACCESS_KEY: "other",
    };
    const env = easEnvironment(shell, config, "expo");
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/example",
      NO_COLOR: "1",
      EXPO_TOKEN: "expo",
      EXPO_ASC_API_KEY_PATH: config.ascKeyPath,
      EXPO_ASC_KEY_ID: config.ascKeyId,
      EXPO_ASC_ISSUER_ID: config.ascIssuerId,
      EXPO_APPLE_TEAM_ID: config.appleTeamId,
      EXPO_APPLE_TEAM_TYPE: "INDIVIDUAL",
      EXPO_NO_DOTENV: "1",
      EAS_BUILD_NO_EXPO_GO_WARNING: "true",
    });
    expect(childEnvironment(shell)).toEqual({ PATH: "/bin", HOME: "/home/example", NO_COLOR: "1" });
  });

  test("streamed child output is redacted, and a child past its limit is stopped", async () => {
    const token = "expo_token_0123456789";
    const sink = () => {
      const parts = [];
      return { parts, write: (text) => parts.push(text) };
    };
    const output = sink();
    const errors = sink();
    await stream(
      process.execPath,
      [
        "-e",
        `process.stdout.write("token ${token.slice(0, 6)}"); setTimeout(() => { process.stdout.write("${token.slice(6)}!"); console.error("${token}"); }, 20);`,
      ],
      { env: childEnvironment(process.env), timeout: 30_000, hidden: [token], output, errors },
    );
    expect(output.parts.join("")).toBe("token [redacted]!");
    expect(errors.parts.join("")).toBe("[redacted]\n");
    const started = Date.now();
    await expect(
      stream(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        env: childEnvironment(process.env),
        timeout: 300,
        hidden: [],
        output: sink(),
        errors: sink(),
      }),
    ).rejects.toThrow("limit");
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(
      stream(process.execPath, ["-e", "process.exit(3)"], {
        env: childEnvironment(process.env),
        timeout: 30_000,
        hidden: [],
        output: sink(),
        errors: sink(),
      }),
    ).rejects.toThrow("exit code 3");
  });

  test("debug settings that can print the Expo token stop the release", () => {
    expect(unsafeDebugVariables({ PATH: "/bin", NODE_OPTIONS: " " })).toEqual([]);
    expect(
      unsafeDebugVariables({ NODE_DEBUG: "child_process", NODE_OPTIONS: "--inspect", DEBUG: "*", EXPO_DEBUG: "1" }),
    ).toEqual(["NODE_DEBUG", "NODE_OPTIONS", "DEBUG", "EXPO_DEBUG"]);
  });

  test("the Expo token and the App Store Connect key are redacted from output", () => {
    const token = "expo_token_0123456789";
    const key =
      // A synthetic key in PEM layout; the label is split so the public-source audit reads it as text.
      `-----BEGIN ${"PRIVATE"} KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49\nAwEHBHkwdwIBAQQg0123456789abcdef\n-----END ${"PRIVATE"} KEY-----\n`;
    const secrets = secretsFrom(token, key);
    expect(secrets).toContain(token);
    expect(secrets).toContain("MIGTAgEAMBMGByqGSM49AgEGCCqGSM49");
    expect(secrets.some((secret) => secret.startsWith("-----") && !secret.includes("\n"))).toBe(false);
    expect(redact(`Authorization: Bearer ${token}\n${key}`, secrets)).not.toMatch(/expo_token|MIGTAgEA|AwEHBHkw/);

    // A secret split across chunks is still redacted, and a prompt is shown as it arrives.
    const written = [];
    const writer = redactingWriter((text) => written.push(text), secrets);
    writer.push("? Choose a profile ");
    expect(written.join("")).toBe("? Choose a profile ");
    writer.push(`token=${token.slice(0, 9)}`);
    writer.push(`${token.slice(9)} done`);
    writer.end();
    expect(written.join("")).toBe("? Choose a profile token=[redacted] done");
  });
});

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
    // An override on the production profile itself counts too.
    const override = structuredClone(easJson);
    override.build.production.ios = { image: "latest" };
    expect(() => checkEasJson(override)).toThrow("macos-tahoe-26.5-xcode-26.6");
    const development = structuredClone(easJson);
    development.build.production.env.APP_VARIANT = "development";
    expect(() => checkEasJson(development)).toThrow("production variant");
  });

  test("build profiles resolve through extends as EAS merges them", () => {
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
    expect(() => resolveProfile(profiles, "loop")).toThrow('"loop"');
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

  test("a commit is released again only while none of its builds was requested", () => {
    const records = [
      { sha, status: "attempt-started" },
      { sha: "b".repeat(40), status: "submitted" },
    ];
    expect(() => checkPriorAttempts(records, sha)).not.toThrow();
    for (const status of ["build-requested", "built", "submit-requested", "submitted"])
      expect(() => checkPriorAttempts([...records, { sha, status }], sha)).toThrow(status);
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
