// Native settings for the fitness-health module: HealthKit read access with
// background delivery, the Health purpose strings, and the Fitness origin the
// module pins every request to.
const { withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");
const { shareDescription, updateDescription } = require("./purpose.js");

/** @type {import("expo/config-plugins").ConfigPlugin<{ fitnessOrigin: string, allowLocalNetworking?: boolean }>} */
function withFitnessHealth(config, options) {
  if (!options || typeof options.fitnessOrigin !== "string")
    throw new Error("fitness-health needs the Fitness origin.");
  const origin = new URL(options.fitnessOrigin).origin;

  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults["com.apple.developer.healthkit"] = true;
    mod.modResults["com.apple.developer.healthkit.background-delivery"] = true;
    delete mod.modResults["com.apple.developer.healthkit.access"];
    return mod;
  });

  config = withInfoPlist(config, (mod) => {
    const plist = mod.modResults;
    plist.NSHealthShareUsageDescription = shareDescription;
    // The app only reads Health data, and this string says so; see purpose.js.
    plist.NSHealthUpdateUsageDescription = updateDescription;
    delete plist.NSHealthClinicalHealthRecordsShareUsageDescription;
    plist.FitnessOrigin = origin;
    const transport = { ...(plist.NSAppTransportSecurity ?? {}) };
    delete transport.NSAllowsArbitraryLoads;
    delete transport.NSExceptionDomains;
    if (options.allowLocalNetworking) transport.NSAllowsLocalNetworking = true;
    else delete transport.NSAllowsLocalNetworking;
    plist.NSAppTransportSecurity = transport;
    return mod;
  });

  return config;
}

module.exports = withFitnessHealth;
