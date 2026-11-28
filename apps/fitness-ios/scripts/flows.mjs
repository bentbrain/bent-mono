// The Simulator flows: a development build signs in through synthetic Clerk
// OAuth, connects, allows or denies Health access and syncs the seeded
// samples to the real Fitness handlers on Postgres. Needs
// FITNESS_TEST_DATABASE_URL and Xcode with an iOS Simulator runtime.
//
//   FITNESS_TEST_DATABASE_URL=postgres://... node scripts/flows.mjs [flow]
//   node scripts/flows.mjs --build-only
//   FITNESS_TEST_DATABASE_URL=postgres://... node scripts/flows.mjs --prebuilt [flow]
//
// --build-only builds the development app and the seeder against the
// harness, without a database. --prebuilt runs the flows on a build already
// in NATIVE_BUILD_DIR, such as one another CI job made: the app under
// app/Build/Products and the seeder's test products under seeder/Build/Products.
//
// Each flow runs on a new Simulator with a fresh install, so Health access
// starts unanswered. The Simulator, the harness and its schema are removed
// at the end. FITNESS_FLOW_BUDGET_SECONDS gives the flows a time budget, for
// a CI job's limit: each attempt, from creating its Simulator to the end of
// its test, must finish with time kept for its cleanup, and a retry starts
// only when enough of the budget is left for a whole attempt.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
const args = process.argv.slice(2);
const mode = args[0] === "--build-only" ? "build" : args[0] === "--prebuilt" ? "prebuilt" : "full";
const only = mode === "full" ? args[0] : args[1];
if (mode !== "build" && !process.env.FITNESS_TEST_DATABASE_URL) {
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
  const result = spawnSync(command, args, { stdio: "inherit", cwd: app, killSignal: "SIGKILL", ...options });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${command} passed the attempt's deadline`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

const budgetSeconds = Number(process.env.FITNESS_FLOW_BUDGET_SECONDS || 0);
if (!Number.isFinite(budgetSeconds) || budgetSeconds < 0)
  throw new Error("FITNESS_FLOW_BUDGET_SECONDS must be a number of seconds, or unset.");
const budgetEnd = budgetSeconds > 0 ? Date.now() + budgetSeconds * 1000 : null;
// Kept from each attempt for its log and the Simulator's removal, each bounded below.
const cleanupMs = 150_000;
// The least time an attempt needs: a Simulator's boot, the install and a flow.
const attemptMs = 360_000;
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

/** Creates a Simulator for one attempt. The attempt boots it, within its deadline. */
function newSimulator(timeout) {
  const runtime = JSON.parse(output("xcrun", ["simctl", "list", "runtimes", "available", "-j"]))
    .runtimes.filter((r) => r.platform === "iOS")
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!runtime) throw new Error("No iOS Simulator runtime is installed.");
  const type = runtime.supportedDeviceTypes.filter((t) => t.productFamily === "iPhone").at(-1);
  return execFileSync("xcrun", ["simctl", "create", "Fitness flows", type.identifier, runtime.identifier], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  }).trim();
}

/** Removes a Simulator, trying the deletion twice. Returns whether it is gone. */
function removeSimulator(udid) {
  const bounded = { stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL" };
  spawnSync("xcrun", ["simctl", "shutdown", udid], bounded);
  for (let i = 0; i < 2; i++) if (spawnSync("xcrun", ["simctl", "delete", udid], bounded).status === 0) return true;
  return false;
}
/** Simulators the run could not remove; the run fails and names them. */
const leftovers = [];

// Build the development variant against the harness, and the seeder.
const env = { ...process.env, ...build };
if (mode !== "prebuilt") {
  run("node", ["scripts/native.mjs", "prebuild"], { env });
  run("node", ["scripts/native.mjs", "build"], { env });
  run("node", ["scripts/native.mjs", "seeder"], { env });
}
if (mode === "build") {
  console.log("Built the development app and the seeder for the Simulator flows.");
  process.exit(0);
}
// A prebuilt app has no generated project beside it, so its path is fixed.
const appPath =
  mode === "prebuilt"
    ? join(buildDir, "app/Build/Products/Release-iphonesimulator/bentFitnessDev.app")
    : execFileSync("node", ["scripts/native.mjs", "app-path"], { cwd: app, encoding: "utf8", env })
        .trim()
        .split("\n")
        .at(-1);
// A prebuilt seeder runs from its test run file, which names its products
// relative to itself.
const testRun =
  mode === "prebuilt"
    ? readdirSync(join(buildDir, "seeder/Build/Products"))
        .filter((name) => name.endsWith(".xctestrun"))
        .map((name) => join(buildDir, "seeder/Build/Products", name))
    : [];
if (mode === "prebuilt" && (!existsSync(appPath) || testRun.length !== 1))
  throw new Error(`The prebuilt app or the seeder's single test run file is missing under ${buildDir}.`);

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
  const flows = (only ? [only] : null) ?? [
    "testDeniedHealthAccessSendsNothing",
    "testAllowedHealthAccessSyncsTheSeededHistory",
    "testPartialHealthAccessHoldsRunsWithoutDistance",
  ];
  // A flow that fails runs once more on a new Simulator: a newly booted
  // Simulator can time out launching an app. Both attempts are logged.
  const attempt = (flow, number) => {
    // The attempt ends early enough to leave its cleanup time in the budget.
    const deadline = budgetEnd === null ? null : budgetEnd - cleanupMs;
    if (deadline !== null && deadline - Date.now() < attemptMs) {
      console.error(`${flow}, attempt ${number}: not enough of the time budget is left for an attempt.`);
      return false;
    }
    const left = () => (deadline === null ? undefined : Math.max(1000, deadline - Date.now()));
    let udid;
    try {
      udid = newSimulator(left());
      run("xcrun", ["simctl", "boot", udid], { timeout: left() });
      run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: left() });
      run("xcrun", ["simctl", "install", udid, appPath], { timeout: left() });
      const source =
        mode === "prebuilt"
          ? ["-xctestrun", testRun[0]]
          : ["-project", "HealthSeed.xcodeproj", "-scheme", "HealthSeed", "-configuration", "Release"];
      run(
        "xcodebuild",
        [
          ...source,
          "-destination",
          `id=${udid}`,
          ...(mode === "prebuilt" ? [] : ["-derivedDataPath", join(buildDir, "seeder")]),
          "-resultBundlePath",
          join(buildDir, `flows-${flow}-${number}-${Date.now()}.xcresult`),
          `-only-testing:SimulatorFlows/SyncFlowTests/${flow}`,
          "test-without-building",
        ],
        { cwd: seeder, env: { ...process.env, TEST_RUNNER_FITNESS_SIM_ORIGIN: origin }, timeout: left() },
      );
      return true;
    } catch (error) {
      console.error(`${flow}, attempt ${number}: ${error.message}`);
      if (!udid) return false;
      // Keep the app's own log for the failed flow; it records codes only.
      // Collecting it is bounded, so it leaves time for the retry.
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
          'process BEGINSWITH "bentFitness"',
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 45_000, killSignal: "SIGKILL" },
      );
      writeFileSync(join(buildDir, `flows-${flow}-${number}-app.log`), log.stdout ?? "");
      return false;
    } finally {
      if (udid && !removeSimulator(udid)) leftovers.push(udid);
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
if (leftovers.length) {
  console.error(`These Simulators could not be removed: ${leftovers.join(", ")}`);
  failed = true;
}
if (failed) process.exit(1);
console.log("Simulator flows passed.");
