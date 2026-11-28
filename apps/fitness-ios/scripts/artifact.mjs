// Checks a built app's entitlements, Info.plist and contents. The Simulator
// build check in native.mjs and the TestFlight release check in
// release-ios.mjs share these rules.

import { createRequire } from "node:module";

const { shareDescription, updateDescription } = createRequire(import.meta.url)("../modules/fitness-health/purpose.js");

export const bundleIds = { production: "build.bent.fitness", development: "build.bent.fitness.dev" };

/**
 * The bytes of a section as `otool -X -s` prints it. Each line is an address,
 * a tab, then the data: single bytes for x86_64 slices, and little-endian
 * 32-bit words for arm64 slices, the last one possibly shorter.
 */
export function otoolSectionBytes(text) {
  return text.split("\n").flatMap((line) => {
    const [, data = ""] = line.split("\t");
    return data
      .trim()
      .split(/\s+/)
      .filter((token) => /^(?:[0-9a-f]{2})+$/.test(token))
      .flatMap((token) => {
        const bytes = token.match(/../g) ?? [];
        // A word is printed as a number, so its bytes read in reverse.
        return (bytes.length > 1 ? bytes.reverse() : bytes).map((byte) => parseInt(byte, 16));
      });
  });
}

/** The HealthKit entitlement keys the app has, each set to true. */
export const healthEntitlements = [
  "com.apple.developer.healthkit",
  "com.apple.developer.healthkit.background-delivery",
];

/** Throws unless the HealthKit keys are exactly the expected ones. Returns them. */
export function checkHealthEntitlements(entitlements) {
  const health = Object.keys(entitlements)
    .filter((key) => key.startsWith("com.apple.developer.healthkit"))
    .sort();
  if (health.join() !== healthEntitlements.join() || healthEntitlements.some((key) => entitlements[key] !== true))
    throw new Error(`Unexpected HealthKit entitlements: ${JSON.stringify(entitlements)}`);
  return health;
}

/** The App Group the app shares with its extension for the Today widget: `group.` followed by the bundle ID. */
export function appGroup(variant) {
  return `group.${bundleIds[variant]}`;
}

const appGroupsKey = "com.apple.security.application-groups";

/** Throws unless the entitlements name exactly the variant's App Group. */
function checkAppGroup(entitlements, variant, what) {
  const groups = entitlements[appGroupsKey];
  if (!Array.isArray(groups) || groups.length !== 1 || groups[0] !== appGroup(variant))
    throw new Error(`${what} must have exactly the App Group ${appGroup(variant)}: ${JSON.stringify(groups ?? null)}`);
}

/**
 * Throws unless the app has exactly the HealthKit keys and exactly the
 * variant's App Group. Returns the HealthKit keys.
 */
export function checkAppEntitlements(entitlements, variant) {
  const health = checkHealthEntitlements(entitlements);
  checkAppGroup(entitlements, variant, "The app");
  return health;
}

/** Throws unless the widget extension has exactly the variant's App Group and no HealthKit access. */
export function checkExtensionEntitlements(entitlements, variant) {
  checkAppGroup(entitlements, variant, "The widget extension");
  if (Object.keys(entitlements).some((key) => key.startsWith("com.apple.developer.healthkit")))
    throw new Error("The widget extension must not have HealthKit entitlements.");
}

/** The extension's executable inside the app bundle. */
export const extensionBinary = "PlugIns/WorkoutActivityExtension.appex/WorkoutActivityExtension";

/**
 * Throws unless the Info.plist reads Health data only and matches the variant.
 * Apple requires a write purpose string, so it must be the one that says the
 * app saves nothing to Apple Health.
 */
export function checkInfoPlist(plist, variant) {
  if (plist.NSHealthShareUsageDescription !== shareDescription)
    throw new Error("NSHealthShareUsageDescription is not the app's Health read purpose string.");
  if (plist.NSHealthUpdateUsageDescription !== updateDescription)
    throw new Error("NSHealthUpdateUsageDescription must say the app doesn't write Health data.");
  if (plist.CFBundleIdentifier !== bundleIds[variant])
    throw new Error(`Expected bundle ID ${bundleIds[variant]}, found ${plist.CFBundleIdentifier}.`);
  if (variant === "production" && plist.NSAppTransportSecurity?.NSAllowsLocalNetworking)
    throw new Error("Production builds must not allow local networking.");
  if (plist.NSSupportsLiveActivities !== true) throw new Error("NSSupportsLiveActivities must be true.");
  if (plist.FitnessAppGroup !== appGroup(variant))
    throw new Error(`FitnessAppGroup must be ${appGroup(variant)}, found ${plist.FitnessAppGroup}.`);
}

/**
 * Throws if the seeder shipped in the app, or the fitness-health module, the
 * fitness-charts module, the workout-activity module with its reminders and
 * widget snapshot, or the widget extension is missing. `files` are the app bundle's paths; `code` is text
 * from the main binary, such as its symbol table or its raw bytes.
 */
export function checkAppContents({ files, code }) {
  // The seeder is its own project and bundle; nothing of it ships in the app.
  if (files.some((file) => /HealthSeed|healthseed/.test(file))) throw new Error("The seeder is inside the app.");
  if (/HealthSeed|Seeder/.test(code)) throw new Error("Seeder code is linked into the app.");
  // Expo leaves out a local module it cannot link, so check it is there.
  if (!/FitnessHealthModule/.test(code)) throw new Error("The fitness-health module is not linked.");
  if (!/FitnessChartsModule/.test(code)) throw new Error("The fitness-charts module is not linked.");
  if (!/WorkoutActivityModule/.test(code)) throw new Error("The workout-activity module is not linked.");
  if (!/WorkoutRemindersModule/.test(code)) throw new Error("The workout reminders module is not linked.");
  if (!/WorkoutWidgetModule/.test(code)) throw new Error("The widget snapshot module is not linked.");
  if (!files.some((file) => file === extensionBinary || file.endsWith(`/${extensionBinary}`)))
    throw new Error("The Live Activity extension is not in the app.");
}

/** Throws unless the extension's binary, read as raw bytes, holds the Live Activity and the Today widget. */
export function checkExtensionContents(code) {
  if (!/WorkoutActivityWidget/.test(code)) throw new Error("The Live Activity is not in the widget extension.");
  if (!/TodayWidget/.test(code)) throw new Error("The Today widget is not in the widget extension.");
}
