import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkAppContents, checkHealthEntitlements, checkInfoPlist } from "../scripts/artifact.mjs";
import {
  checkAuthorizationServer,
  checkBuild,
  checkEasJson,
  checkOAuthSettings,
  checkReadiness,
  checkSignedEntitlements,
  checkXcodeLog,
  easEnvironment,
  parseArgs,
  parseEnvList,
  projectIdFrom,
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

  test("EAS gets the Expo token and App Store Connect key, and no other release credentials", () => {
    const env = easEnvironment({ PATH: "/bin", GH_TOKEN: "gh", VERCEL_TOKEN: "v" }, config, "expo");
    expect(env).toMatchObject({
      PATH: "/bin",
      EXPO_TOKEN: "expo",
      EXPO_ASC_API_KEY_PATH: config.ascKeyPath,
      EXPO_ASC_KEY_ID: config.ascKeyId,
      EXPO_ASC_ISSUER_ID: config.ascIssuerId,
      EXPO_APPLE_TEAM_ID: config.appleTeamId,
      EXPO_APPLE_TEAM_TYPE: "INDIVIDUAL",
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.VERCEL_TOKEN).toBeUndefined();
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
  test("Fitness production must report enrollment enabled", () => {
    expect(() => checkReadiness(200, { enrollment: "enabled" })).not.toThrow();
    expect(() => checkReadiness(503, { code: "enrollment_unavailable" })).toThrow("enrollment_unavailable");
    expect(() => checkReadiness(200, {})).toThrow("not ready");
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
