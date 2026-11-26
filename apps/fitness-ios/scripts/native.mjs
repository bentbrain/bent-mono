// Native build and test steps for bent Fitness, shared by CI and local runs.
//
//   node scripts/native.mjs xcode <version>     require this Xcode version
//   node scripts/native.mjs prebuild            generate ios/ for APP_VARIANT
//   node scripts/native.mjs build               build the app for the Simulator
//   node scripts/native.mjs seeder              build the seeder and its UI tests
//   node scripts/native.mjs core-test [filter]  run the module's XCTest suite
//   node scripts/native.mjs core-build          build the module and its tests
//   node scripts/native.mjs artifact            check the app's entitlements and Info.plist
//   node scripts/native.mjs lint                run SwiftLint
//   node scripts/native.mjs flows [filter]      run the Simulator flows on a new Simulator
//   node scripts/native.mjs replay-swift [scope] compile the first-party Swift again from
//                                               the build logs, for CodeQL: all (the
//                                               default), app or seeder
//
// Build output goes to NATIVE_BUILD_DIR, or ~/Library/Caches/fitness-ios-build,
// never into the repository.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppContents, checkHealthEntitlements, checkInfoPlist } from "./artifact.mjs";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Build output stays in this user's caches unless NATIVE_BUILD_DIR names another place.
const buildDir = resolve(process.env.NATIVE_BUILD_DIR || join(homedir(), "Library/Caches/fitness-ios-build"));
const derived = join(buildDir, "app");
const seederDerived = join(buildDir, "seeder");
const core = join(app, "modules/fitness-health/ios");
const seeder = join(app, "tools/health-seed");
const variant = process.env.APP_VARIANT || "production";

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: app, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const output = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", cwd: app, maxBuffer: 256 * 1024 * 1024, ...options });

/** Runs xcodebuild, printing its output and keeping a copy in `log`. */
function xcodebuild(args, log, options = {}) {
  console.log(`$ xcodebuild ${args.join(" ")}`);
  const result = spawnSync("xcodebuild", args, {
    cwd: app,
    ...options,
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  writeFileSync(log, result.stdout);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * The Swift compile commands a build log shows for the given targets, for
 * the arm64 slice: each target's working directory and its swiftc command,
 * exactly as Xcode ran them.
 */
function swiftCommands(log, targets) {
  const lines = readFileSync(log, "utf8").split("\n");
  const commands = [];
  for (const [i, line] of lines.entries()) {
    const target = /^SwiftDriver (\S+) normal arm64 /.exec(line)?.[1];
    if (!target || !targets.includes(target)) continue;
    const cd = lines[i + 1]?.trim();
    const driver = lines[i + 2]?.trim();
    if (!cd?.startsWith("cd ") || !driver?.startsWith("builtin-SwiftDriver -- "))
      throw new Error(`Unexpected compile entry for ${target} in ${log}.`);
    commands.push({ target, cd: cd.slice(3), command: driver.slice("builtin-SwiftDriver -- ".length) });
  }
  return commands;
}

/** Extra xcodebuild settings, such as CodeQL's, from XCODEBUILD_SETTINGS. */
const extraSettings = (process.env.XCODEBUILD_SETTINGS ?? "").split(/\s+/).filter(Boolean);

/** The replay-swift scope: all, app or seeder, with all as the default. */
export function replayScope(args) {
  if (args.length > 1) throw new Error("Pass at most one replay-swift scope: all, app or seeder.");
  const [scope = "all"] = args;
  if (!["all", "app", "seeder"].includes(scope)) throw new Error("Choose a replay-swift scope: all, app or seeder.");
  return scope;
}

/** The generated project's name: bentFitness, or bentFitnessDev for development. */
function project() {
  const workspace = readdirSync(join(app, "ios")).find((name) => name.endsWith(".xcworkspace"));
  if (!workspace) throw new Error("Run prebuild first.");
  return workspace.replace(/\.xcworkspace$/, "");
}

function appPath() {
  return join(derived, `Build/Products/Release-iphonesimulator/${project()}.app`);
}

const commands = {
  xcode([version]) {
    const reported = output("xcodebuild", ["-version"]).split("\n")[0]?.trim();
    if (reported !== `Xcode ${version}`) throw new Error(`Expected Xcode ${version}, found ${reported}.`);
    console.log(output("xcrun", ["swift", "--version"]).trim());
    console.log(`Verified Xcode ${version}.`);
  },

  prebuild() {
    run("npx", ["expo", "prebuild", "--platform", "ios", "--clean"], {
      env: { ...process.env, APP_VARIANT: variant, EXPO_NO_GIT_STATUS: "1", LANG: "en_US.UTF-8" },
    });
  },

  /** Prints the built app's path. */
  "app-path"() {
    console.log(appPath());
  },

  build() {
    mkdirSync(buildDir, { recursive: true });
    xcodebuild(
      [
        "-workspace",
        `ios/${project()}.xcworkspace`,
        "-scheme",
        project(),
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-destination",
        "generic/platform=iOS Simulator",
        "-derivedDataPath",
        derived,
        ...extraSettings,
        "build",
      ],
      join(buildDir, "app-build.log"),
    );
  },

  seeder() {
    mkdirSync(buildDir, { recursive: true });
    xcodebuild(
      [
        "-project",
        "HealthSeed.xcodeproj",
        "-scheme",
        "HealthSeed",
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-destination",
        "generic/platform=iOS Simulator",
        "-derivedDataPath",
        seederDerived,
        ...extraSettings,
        "build-for-testing",
      ],
      join(buildDir, "seeder-build.log"),
      { cwd: seeder },
    );
  },

  /**
   * Runs again, for the arm64 slice, the Swift compile commands of the
   * first-party targets from the last app and seeder builds: the app target
   * with the Swift prebuild generates, the fitness-health module, the seeder
   * and its UI tests. CodeQL traces this instead of a whole Xcode build.
   * The app scope reads only the app build, and the seeder scope only the
   * seeder build.
   */
  "replay-swift"(args) {
    const scope = replayScope(args);
    const builds = [];
    if (scope !== "seeder") builds.push({ log: "app-build.log", targets: ["FitnessHealth", project()] });
    if (scope !== "app") builds.push({ log: "seeder-build.log", targets: ["HealthSeed", "SimulatorFlows"] });
    const targets = builds.flatMap((build) => swiftCommands(join(buildDir, build.log), build.targets));
    const expected = builds.flatMap((build) => build.targets);
    const missing = expected.filter((target) => !targets.some((entry) => entry.target === target));
    if (missing.length) throw new Error(`No compile commands for ${missing.join(", ")}. Build from clean first.`);
    for (const entry of targets) {
      console.log(`Compiling ${entry.target} again for extraction.`);
      const result = spawnSync("/bin/sh", ["-c", `cd ${entry.cd} && ${entry.command}`], { stdio: "inherit" });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  },

  "core-build"() {
    run("swift", ["build", "--build-tests", "--scratch-path", join(buildDir, "core")], { cwd: core });
  },

  "core-test"([filter]) {
    run("swift", ["test", "--scratch-path", join(buildDir, "core"), ...(filter ? ["--filter", filter] : [])], {
      cwd: core,
    });
  },

  lint() {
    run("swiftlint", ["lint", "--strict", "--config", join(app, ".swiftlint.yml")], { cwd: app });
  },

  artifact() {
    const binary = join(appPath(), project());
    // Simulator builds carry their entitlements in a section of the binary.
    const section = output("xcrun", ["otool", "-X", "-s", "__TEXT", "__entitlements", binary]);
    const bytes = section
      .split("\n")
      .flatMap((line) => line.split("\t").slice(1).join(" ").trim().split(/\s+/))
      .filter((byte) => /^[0-9a-f]{2}$/.test(byte));
    const entitlements = JSON.parse(
      output("plutil", ["-convert", "json", "-o", "-", "-"], {
        input: Buffer.from(bytes.map((b) => parseInt(b, 16))),
      }),
    );
    const health = checkHealthEntitlements(entitlements);
    const plist = JSON.parse(output("plutil", ["-convert", "json", "-o", "-", join(appPath(), "Info.plist")]));
    checkInfoPlist(plist, variant);
    checkAppContents({ files: output("find", [appPath()]).split("\n"), code: output("nm", ["-U", binary]) });
    console.log(`Artifact: ${plist.CFBundleIdentifier} reads Health data only, with ${health.join(", ")}.`);
  },

  flows([filter]) {
    const runtime = JSON.parse(output("xcrun", ["simctl", "list", "runtimes", "available", "-j"]))
      .runtimes.filter((r) => r.platform === "iOS")
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    if (!runtime) throw new Error("No iOS Simulator runtime is installed.");
    const type = runtime.supportedDeviceTypes.filter((t) => t.productFamily === "iPhone").at(-1);
    const udid = output("xcrun", ["simctl", "create", "Fitness flows", type.identifier, runtime.identifier]).trim();
    try {
      run("xcrun", ["simctl", "boot", udid]);
      run("xcrun", ["simctl", "bootstatus", udid, "-b"]);
      if (existsSync(appPath())) run("xcrun", ["simctl", "install", udid, appPath()]);
      const results = join(buildDir, `flows-${Date.now()}.xcresult`);
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
          seederDerived,
          "-resultBundlePath",
          results,
          ...(filter ? [`-only-testing:SimulatorFlows/${filter}`] : []),
          "test-without-building",
        ],
        { cwd: seeder },
      );
    } finally {
      spawnSync("xcrun", ["simctl", "shutdown", udid], { stdio: "inherit" });
      spawnSync("xcrun", ["simctl", "delete", udid], { stdio: "inherit" });
    }
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...rest] = process.argv.slice(2);
  const command = commands[name];
  if (!command) {
    console.error(`Choose one of: ${Object.keys(commands).join(", ")}`);
    process.exit(2);
  }
  command(rest);
}
