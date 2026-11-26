// The Simulator flows: a development build signs in through synthetic Clerk
// OAuth, connects, allows or denies Health access and syncs the seeded
// samples to the real Fitness handlers on Postgres. Needs
// FITNESS_TEST_DATABASE_URL and Xcode with an iOS Simulator runtime.
//
//   FITNESS_TEST_DATABASE_URL=postgres://... node scripts/flows.mjs
//
// Each flow runs on a new Simulator with a fresh install, so Health access
// starts unanswered. The Simulator, the harness and its schema are removed
// at the end.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fitness = resolve(app, "../fitness");
const seeder = join(app, "tools/health-seed");
// Build output stays in this user's caches unless NATIVE_BUILD_DIR names another place.
const buildDir = resolve(process.env.NATIVE_BUILD_DIR || join(homedir(), "Library/Caches/fitness-ios-build"));
const port = Number(process.env.FITNESS_IOS_SIM_PORT || 39125);
const origin = `http://127.0.0.1:${port}`;
if (!process.env.FITNESS_TEST_DATABASE_URL) {
  console.error("Set FITNESS_TEST_DATABASE_URL to a Postgres database for the harness.");
  process.exit(2);
}
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const build = {
  APP_VARIANT: "development",
  FITNESS_ORIGIN: origin,
  FITNESS_OAUTH_ISSUER: origin,
  FITNESS_OAUTH_CLIENT_ID: "client_synthetic_ios",
  NATIVE_BUILD_DIR: buildDir,
};

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: app, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
const output = (command, args) => execFileSync(command, args, { encoding: "utf8" });

async function waitForHarness() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${origin}/__state`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The harness did not start.");
}

// The harness closes idle connections while a flow runs, so a request can
// meet a closed socket; it is sent again on a new connection.
async function post(path) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(`${origin}${path}`, { method: "POST" });
    } catch (error) {
      if (i === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function newSimulator() {
  const runtime = JSON.parse(output("xcrun", ["simctl", "list", "runtimes", "available", "-j"]))
    .runtimes.filter((r) => r.platform === "iOS")
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!runtime) throw new Error("No iOS Simulator runtime is installed.");
  const type = runtime.supportedDeviceTypes.filter((t) => t.productFamily === "iPhone").at(-1);
  const udid = output("xcrun", ["simctl", "create", "Fitness flows", type.identifier, runtime.identifier]).trim();
  run("xcrun", ["simctl", "boot", udid]);
  run("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  return udid;
}

function removeSimulator(udid) {
  spawnSync("xcrun", ["simctl", "shutdown", udid], { stdio: "inherit" });
  spawnSync("xcrun", ["simctl", "delete", udid], { stdio: "inherit" });
}

// Build the development variant against the harness, and the seeder.
const env = { ...process.env, ...build };
run("node", ["scripts/native.mjs", "prebuild"], { env });
run("node", ["scripts/native.mjs", "build"], { env });
run("node", ["scripts/native.mjs", "seeder"], { env });
const appPath = execFileSync("node", ["scripts/native.mjs", "app-path"], { cwd: app, encoding: "utf8", env })
  .trim()
  .split("\n")
  .at(-1);

// The harness serves every flow, so it runs for up to an hour: its test
// timeout, and the Fitness test deadline, which is 15 minutes by default.
const harnessLimitMs = "3600000";
const harness = spawn("bun", ["test", "tests/ios-simulator.harness.test.ts", "--timeout", harnessLimitMs], {
  cwd: fitness,
  stdio: "inherit",
  env: {
    ...process.env,
    FITNESS_IOS_SIM_PORT: String(port),
    FITNESS_IOS_SIM_TIMEZONE: timezone,
    FITNESS_TEST_DEADLINE_MS: harnessLimitMs,
  },
});
let failed = false;
try {
  await waitForHarness();
  mkdirSync(buildDir, { recursive: true });
  const flows = (process.argv[2] ? [process.argv[2]] : null) ?? [
    "testDeniedHealthAccessSendsNothing",
    "testAllowedHealthAccessSyncsTheSeededHistory",
    "testPartialHealthAccessHoldsRunsWithoutDistance",
  ];
  // A flow that fails runs once more on a new Simulator: a newly booted
  // Simulator can time out launching an app. Both attempts are logged.
  const attempt = (flow, number) => {
    const udid = newSimulator();
    try {
      run("xcrun", ["simctl", "install", udid, appPath]);
      run(
        "xcodebuild",
        [
          "-project",
          "HealthSeed.xcodeproj",
          "-scheme",
          "HealthSeed",
          "-configuration",
          "Release",
          "-destination",
          `id=${udid}`,
          "-derivedDataPath",
          join(buildDir, "seeder"),
          "-resultBundlePath",
          join(buildDir, `flows-${flow}-${number}-${Date.now()}.xcresult`),
          `-only-testing:SimulatorFlows/SyncFlowTests/${flow}`,
          "test-without-building",
        ],
        { cwd: seeder, env: { ...process.env, TEST_RUNNER_FITNESS_SIM_ORIGIN: origin } },
      );
      return true;
    } catch (error) {
      console.error(`${flow}, attempt ${number}: ${error.message}`);
      // Keep the app's own log for the failed flow; it records codes only.
      const log = spawnSync(
        "xcrun",
        [
          "simctl",
          "spawn",
          udid,
          "log",
          "show",
          "--last",
          "10m",
          "--style",
          "compact",
          "--predicate",
          'process BEGINSWITH "FitnessSync"',
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      writeFileSync(join(buildDir, `flows-${flow}-${number}-app.log`), log.stdout ?? "");
      return false;
    } finally {
      removeSimulator(udid);
    }
  };
  // Each attempt starts from an empty account and zero request counts.
  const reset = async () => {
    const response = await post("/__reset");
    if (!response.ok) throw new Error(`The harness reset answered ${response.status}.`);
  };
  for (const flow of flows) {
    await reset();
    if (attempt(flow, 1)) continue;
    console.error(`${flow} failed; running it again on a new Simulator.`);
    await reset();
    if (!attempt(flow, 2)) failed = true;
  }
} finally {
  await post("/__stop").catch(() => harness.kill());
  await new Promise((resolve) => harness.on("exit", resolve));
}
if (failed) process.exit(1);
console.log("Simulator flows passed.");
