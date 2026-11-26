// The Health purpose strings in the app's Info.plist, shared by the config
// plugin and the artifact check.

/** Shown when the app asks to read Health data. */
const shareDescription =
  "bent Fitness reads your weigh-ins and running workouts and sends them to your Fitness account.";

/**
 * Apple requires this string for any app that calls HealthKit's
 * requestAuthorization(toShare:read:), even when it asks to write nothing.
 * The app passes no types to write, so iOS never shows it.
 */
const updateDescription =
  "bent Fitness doesn't save anything to Apple Health. It only reads your weigh-ins and running workouts.";

module.exports = { shareDescription, updateDescription };
