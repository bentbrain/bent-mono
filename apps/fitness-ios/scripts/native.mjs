// Native build and test steps for Fitness Sync, shared by CI and local runs.
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
//   node scripts/native.mjs touch-sources       mark first-party Swift as changed, so the
//                                               next build compiles it again
//
// Build output goes to NATIVE_BUILD_DIR, or a directory under the system
// temporary directory, never into the repository.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const buildDir = resolve(process.env.NATIVE_BUILD_DIR || join(tmpdir(), "fitness-ios-build"));
const derived = join(buildDir, "app");
const seederDerived = join(buildDir, "seeder");
const core = join(app, "modules/fitness-health/ios");
const seeder = join(app, "tools/health-seed");
const variant = process.env.APP_VARIANT || "production";
const bundleIds = { production: "build.bent.fitness", development: "build.bent.fitness.dev" };

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: app, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const output = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", cwd: app, ...options });

/** Extra xcodebuild settings, such as CodeQL's, from XCODEBUILD_SETTINGS. */
const extraSettings = (process.env.XCODEBUILD_SETTINGS ?? "").split(/\s+/).filter(Boolean);

/** The generated project's name: FitnessSync, or FitnessSyncDev for development. */
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
    run("xcodebuild", [
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
    ]);
  },

  seeder() {
    mkdirSync(buildDir, { recursive: true });
    run(
      "xcodebuild",
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
      { cwd: seeder },
    );
  },

  /**
   * Updates the modification time of every tracked Swift file and of each
   * Swift file the app target compiles, including generated ones, so the
   * next build recompiles them while reusing third-party build products.
   */
  "touch-sources"() {
    const tracked = output("git", ["ls-files", "*.swift"])
      .split("\n")
      .filter(Boolean)
      .map((f) => join(app, f));
    const lists = output("find", [join(derived, "Build/Intermediates.noindex"), "-name", "*.SwiftFileList"])
      .split("\n")
      .filter((list) => /\/(FitnessSync(?:Dev)?)\.build\/.*\/\1\.SwiftFileList$/.test(list));
    const generated = lists.flatMap((list) =>
      output("cat", [list])
        .split("\n")
        .map((line) => line.trim().replace(/\\(.)/g, "$1"))
        .filter(Boolean),
    );
    const files = [...new Set([...tracked, ...generated])];
    const now = new Date();
    for (const file of files) utimesSync(file, now, now);
    console.log(`Marked ${files.length} Swift files as changed.`);
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
    const health = Object.keys(entitlements)
      .filter((key) => key.startsWith("com.apple.developer.healthkit"))
      .sort();
    const expected = ["com.apple.developer.healthkit", "com.apple.developer.healthkit.background-delivery"];
    if (health.join() !== expected.join() || expected.some((key) => entitlements[key] !== true))
      throw new Error(`Unexpected HealthKit entitlements: ${JSON.stringify(entitlements)}`);
    const plist = JSON.parse(output("plutil", ["-convert", "json", "-o", "-", join(appPath(), "Info.plist")]));
    if (!plist.NSHealthShareUsageDescription) throw new Error("NSHealthShareUsageDescription is missing.");
    if ("NSHealthUpdateUsageDescription" in plist) throw new Error("The app must not ask to write Health data.");
    if (plist.CFBundleIdentifier !== bundleIds[variant])
      throw new Error(`Expected bundle ID ${bundleIds[variant]}, found ${plist.CFBundleIdentifier}.`);
    if (variant === "production" && plist.NSAppTransportSecurity?.NSAllowsLocalNetworking)
      throw new Error("Production builds must not allow local networking.");
    // The seeder is its own project and bundle; nothing of it ships in the app.
    const files = output("find", [appPath()]).split("\n");
    if (files.some((file) => /HealthSeed|healthseed/.test(file))) throw new Error("The seeder is inside the app.");
    const symbols = output("nm", ["-U", binary]);
    if (/HealthSeed|Seeder/.test(symbols)) throw new Error("Seeder code is linked into the app.");
    // Expo leaves out a local module it cannot link, so check it is there.
    if (!/FitnessHealthModule/.test(symbols)) throw new Error("The fitness-health module is not linked.");
    console.log(`Artifact: ${plist.CFBundleIdentifier} reads Health data only, with ${health.join(", ")}.`);
  },

  flows([filter]) {
    const runtime = JSON.parse(output("xcrun", ["simctl", "list", "runtimes", "available", "-j"]))
      .runtimes.filter((r) => r.platform === "iOS")
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    if (!runtime) throw new Error("No iOS Simulator runtime is installed.");
    const type = runtime.supportedDeviceTypes.filter((t) => t.productFamily === "iPhone").at(-1);
    const udid = output("xcrun", [
      "simctl",
      "create",
      "Fitness Sync flows",
      type.identifier,
      runtime.identifier,
    ]).trim();
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

const [name, ...rest] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error(`Choose one of: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
command(rest);
