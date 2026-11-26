import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppContents, checkHealthEntitlements, checkInfoPlist } from "../scripts/artifact.mjs";
import {
  checkAuthorizationServer,
  checkBuild,
  carriesParameters,
  checkClientAtIssuer,
  checkIosBuild,
  checkNoEasBuilds,
  claimBuild,
  claimPathFor,
  checkEasJson,
  checkEmbeddedConfig,
  checkOAuthSettings,
  checkPriorAttempts,
  checkPrivacyPage,
  checkProtectedResource,
  checkReadiness,
  checkSignedEntitlements,
  checkXcodeLog,
  ownedGroup,
  printSummary,
  childEnvironment,
  easEnvironment,
  effectiveIosProfile,
  execute,
  failureDetail,
  parseArgs,
  parseEnvList,
  projectIdFrom,
  redact,
  redactingWriter,
  resolveProfile,
  secretsFrom,
  signInPage,
  summary,
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
    expect(() => parseArgs(["credentials", "--config", "/x"])).toThrow("Usage");
    expect(() => parseArgs(["build", "--config", "/x"])).toThrow("Usage");
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

  const sink = () => {
    const parts = [];
    return { parts, write: (text) => parts.push(text) };
  };
  const quiet = { env: childEnvironment(process.env), hidden: [], output: sink(), errors: sink() };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Whether `pid` has exited within two seconds; a killed process can take a moment to go. */
  const exits = async (pid) => {
    for (let wait = 0; wait < 40 && alive(pid); wait++) await new Promise((wake) => setTimeout(wake, 50));
    return !alive(pid);
  };

  test("shown child output is redacted as it arrives", async () => {
    const token = "expo_token_0123456789";
    const output = sink();
    const errors = sink();
    await execute(
      process.execPath,
      [
        "-e",
        `process.stdout.write("token ${token.slice(0, 6)}"); setTimeout(() => { process.stdout.write("${token.slice(6)}!"); console.error("${token}"); }, 20);`,
      ],
      { env: childEnvironment(process.env), timeout: 30_000, show: true, hidden: [token], output, errors },
    );
    expect(output.parts.join("")).toBe("token [redacted]!");
    expect(errors.parts.join("")).toBe("[redacted]\n");
    await expect(execute(process.execPath, ["-e", "process.exit(3)"], { ...quiet, timeout: 30_000 })).rejects.toThrow(
      "exit code 3",
    );
    expect(
      (await execute(process.execPath, ["-e", "process.stdout.write('ok')"], { ...quiet, timeout: 30_000 })).stdout,
    ).toBe("ok");
  });

  test("failure output is redacted before it is cut, so no part of a secret shows", async () => {
    const token = "expo_token_0123456789";
    // The token straddles the 4000-character cut.
    const text = `${token}${"x".repeat(3995)}`;
    expect(failureDetail(text, [token])).not.toContain("0123456789".slice(-5));
    expect(failureDetail(text, [token])).toBe(`[redacted]${"x".repeat(3995)}`.slice(-4000));
    const shown = `${"y".repeat(3990)}${token}`;
    const script = `process.stderr.write(${JSON.stringify(shown)}); process.exit(1)`;
    const failure = await execute(process.execPath, ["-e", script], {
      ...quiet,
      hidden: [token],
      timeout: 30_000,
    }).catch((error) => error);
    expect(failure.message).toContain("[redacted]");
    expect(failure.message).not.toMatch(/_token|56789/);
  });

  test("a command past its limit is stopped with its descendants", async () => {
    // The child starts a grandchild that inherits the pipes, then both wait.
    const script =
      "const { spawn } = require('node:child_process');" +
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });" +
      "console.log(grandchild.pid); setTimeout(() => {}, 60000);";
    const output = sink();
    const started = Date.now();
    const failure = await execute(process.execPath, ["-e", script], {
      ...quiet,
      timeout: 400,
      grace: 200,
      show: true,
      output,
    }).catch((error) => error);
    expect(failure.message).toContain("limit");
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(output.parts.join("").trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await exits(grandchild)).toBe(true);
  });

  test("a command leads a process group of its own, apart from the release's", async () => {
    const group = (pid) =>
      Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
    const script =
      "const { execSync } = require('node:child_process'); console.log(execSync('ps -o pgid= -p ' + process.pid).toString().trim(), process.pid);";
    const reply = await execute(process.execPath, ["-e", script], { ...quiet, timeout: 30_000 });
    const [pgid, pid] = reply.stdout.trim().split(/\s+/).map(Number);
    expect(pgid).toBe(pid);
    expect(pgid).not.toBe(group(process.pid));
  });

  test("only a group the command leads is ever signalled", () => {
    const table = [
      { pid: 60, ppid: 50, pgid: 60, seconds: 9 }, // the release, leading its shell job
      { pid: 70, ppid: 60, pgid: 70, seconds: 1 }, // a command that made its own group
      { pid: 71, ppid: 60, pgid: 60, seconds: 1 }, // a command that inherited the release's group
      { pid: 72, ppid: 60, pgid: 90, seconds: 1 }, // a command in some other group
    ];
    expect(ownedGroup(70, table, 60)).toBe(70);
    expect(ownedGroup(71, table, 60)).toBeNull();
    expect(ownedGroup(72, table, 60)).toBeNull();
    // The release's own group, or init's, is never a command's.
    expect(ownedGroup(60, table, 60)).toBeNull();
    expect(ownedGroup(1, table, 60)).toBeNull();
    // A command that already exited made its group when it started.
    expect(ownedGroup(80, table, 60)).toBe(80);
  });

  /** A release runner: it runs one command that starts a helper, as the release does, until it is stopped. */
  const runnerSource = `
import { writeFileSync } from "node:fs";
const [, , modulePath, dir] = process.argv;
const { childEnvironment, execute, stopChildrenOnInterrupt } = await import(modulePath);
writeFileSync(dir + "/runner", JSON.stringify({ pid: process.pid }));
stopChildrenOnInterrupt({ beforeExit: (signal) => writeFileSync(dir + "/after", JSON.stringify({ signal })) });
const command = [
  "const { spawn } = require('node:child_process');",
  "const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
  "require('node:fs').writeFileSync(" + JSON.stringify(dir + "/command") + ", JSON.stringify({ pid: process.pid, helper: helper.pid }));",
  "setTimeout(() => {}, 60000);",
].join("\\n");
await execute(process.execPath, ["-e", command], {
  env: childEnvironment(process.env),
  timeout: 60000,
  grace: 300,
  show: true,
  hidden: [],
});
`;
  const waitFor = async (path) => {
    for (let wait = 0; wait < 300 && !existsSync(path); wait++) await new Promise((wake) => setTimeout(wake, 50));
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const runRelease = () => {
    const dir = mkdtempSync(join(tmpdir(), "release-stop-"));
    const runner = join(dir, "runner.mjs");
    writeFileSync(runner, runnerSource);
    const module = new URL("../scripts/release-ios.mjs", import.meta.url).href;
    const child = spawn(process.execPath, [runner, module, dir], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
    return { dir, exited, kill: () => child.kill("SIGKILL") };
  };

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ])
    test(`${signal} to the release stops each command's tree before it exits`, async () => {
      const release = runRelease();
      try {
        const runner = await waitFor(join(release.dir, "runner"));
        const command = await waitFor(join(release.dir, "command"));
        process.kill(runner.pid, signal);
        // The release exits from its own handler, after stopping the tree.
        expect(await release.exited).toBe(code);
        expect(await waitFor(join(release.dir, "after"))).toEqual({ signal });
        expect(await exits(command.helper)).toBe(true);
        expect(await exits(command.pid)).toBe(true);
      } finally {
        release.kill();
        rmSync(release.dir, { recursive: true, force: true });
      }
    }, 30_000);

  test("stdout carries only the final JSON summary, while command output goes to stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "release-stdout-"));
    try {
      // A fake eas that prints progress on both streams, then succeeds.
      const fakeEas = join(dir, "eas.mjs");
      writeFileSync(
        fakeEas,
        "process.stdout.write('Submitting build...\\n'); console.error('Waiting for App Store Connect'); process.stdout.write('✔ Submitted\\n');",
      );
      const script = join(dir, "release.mjs");
      writeFileSync(
        script,
        `const { childEnvironment, execute, printSummary } = await import(${JSON.stringify(new URL("../scripts/release-ios.mjs", import.meta.url).href)});
await execute(process.execPath, [${JSON.stringify(fakeEas)}, "submit"], { env: childEnvironment(process.env), timeout: 30000, show: true, hidden: [] });
printSummary({ status: "submitted", buildId: "b1", version: "1.0.0", buildNumber: "7", oauthClientId: "client", quality: {} });`,
      );
      const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"status":"submitted","buildId":"b1","version":"1.0.0","buildNumber":"7"}\n');
      expect(JSON.parse(result.stdout)).toEqual({
        status: "submitted",
        buildId: "b1",
        version: "1.0.0",
        buildNumber: "7",
      });
      expect(result.stderr).toContain("Submitting build...");
      expect(result.stderr).toContain("Waiting for App Store Connect");
      expect(result.stderr).toContain("✔ Submitted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("printSummary writes one JSON line", () => {
    const written = [];
    printSummary(
      { status: "submitted", buildId: "b", version: "1", buildNumber: "2", sha },
      { write: (text) => written.push(text) },
    );
    expect(written).toEqual(['{"status":"submitted","buildId":"b","version":"1","buildNumber":"2"}\n']);
  });

  test("a command that exits before reading its input settles normally", async () => {
    const input = "x".repeat(4 * 1024 * 1024);
    await expect(
      execute(process.execPath, ["-e", "process.exit(0)"], { ...quiet, input, timeout: 30_000 }),
    ).resolves.toEqual({ stdout: "", stderr: "" });
    await expect(
      execute(process.execPath, ["-e", "process.exit(2)"], { ...quiet, input, timeout: 30_000 }),
    ).rejects.toThrow("exit code 2");
    // A command that reads its input still gets all of it.
    const { stdout } = await execute(
      process.execPath,
      ["-e", "let n = 0; process.stdin.on('data', (c) => (n += c.length)).on('end', () => console.log(n));"],
      { ...quiet, input, timeout: 30_000 },
    );
    expect(Number(stdout)).toBe(input.length);
  });

  test("a descendant left holding the pipes does not hold a finished command", async () => {
    const script =
      "const { spawn } = require('node:child_process');" +
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });" +
      "console.log(grandchild.pid); grandchild.unref(); process.exit(0);";
    const started = Date.now();
    const { stdout } = await execute(process.execPath, ["-e", script], { ...quiet, timeout: 30_000, grace: 200 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await exits(Number(stdout.trim()))).toBe(true);
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
  test("build claims live in one place per user, keyed by EAS project and commit", () => {
    const projectId = "50ba8677-0be0-45a5-ac8c-ceff89d65696";
    expect(claimPathFor(projectId, sha, "/home/example")).toBe(
      `/home/example/.local/state/fitness-ios-release/claims/${projectId}/${sha}.claim`,
    );
    // The work directory plays no part, so two configurations share a claim.
    expect(claimPathFor(projectId, sha, "/home/example")).toBe(claimPathFor(projectId, sha, "/home/example"));
    expect(() => claimPathFor("../x", sha)).toThrow("EAS project ID");
    expect(() => claimPathFor(projectId, "abc")).toThrow("full SHA");
  });

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

  test("a commit is released again only while none of its builds was requested", () => {
    const records = [
      { sha, status: "attempt-started" },
      { sha: "b".repeat(40), status: "submitted" },
    ];
    expect(() => checkPriorAttempts(records, sha)).not.toThrow();
    for (const status of ["build-requested", "built", "submit-requested", "submitted"])
      expect(() => checkPriorAttempts([...records, { sha, status }], sha)).toThrow(status);
  });

  test("of two runs claiming a commit's build at once, one gets it, and the claim stays", async () => {
    const home = mkdtempSync(join(tmpdir(), "release-claim-"));
    try {
      const path = claimPathFor(projectId, sha, home);
      const results = await Promise.allSettled([claimBuild(path, { run: 1 }), claimBuild(path, { run: 2 })]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected");
      expect(refused.reason.message).toContain("already claimed");
      expect(JSON.parse(readFileSync(path, "utf8")).run).toBeGreaterThan(0);
      await expect(claimBuild(path, { run: 3 })).rejects.toThrow("already claimed");
      // A run that stops before the build request releases its claim.
      await results.find((result) => result.status === "fulfilled").value.release();
      const again = await claimBuild(path, { run: 4 });
      expect(JSON.parse(readFileSync(path, "utf8")).run).toBe(4);
      await again.release();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
