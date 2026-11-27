// Checks a built app's entitlements, Info.plist and contents. The Simulator
// build check in native.mjs and the TestFlight release check in
// release-ios.mjs share these rules.

import { createRequire } from "node:module";

const { shareDescription, updateDescription } = createRequire(import.meta.url)("../modules/fitness-health/purpose.js");

export const bundleIds = { production: "build.bent.fitness", development: "build.bent.fitness.dev" };

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
}

/**
 * Throws if the seeder shipped in the app, or the fitness-health module, the
 * workout-activity module or the Live Activity extension is missing. `files`
 * are the app bundle's paths; `code` is text from the main binary, such as
 * its symbol table or its raw bytes.
 */
export function checkAppContents({ files, code }) {
  // The seeder is its own project and bundle; nothing of it ships in the app.
  if (files.some((file) => /HealthSeed|healthseed/.test(file))) throw new Error("The seeder is inside the app.");
  if (/HealthSeed|Seeder/.test(code)) throw new Error("Seeder code is linked into the app.");
  // Expo leaves out a local module it cannot link, so check it is there.
  if (!/FitnessHealthModule/.test(code)) throw new Error("The fitness-health module is not linked.");
  if (!/WorkoutActivityModule/.test(code)) throw new Error("The workout-activity module is not linked.");
  if (!files.some((file) => /(^|\/)PlugIns\/WorkoutActivityExtension\.appex\/WorkoutActivityExtension$/.test(file)))
    throw new Error("The Live Activity extension is not in the app.");
}
