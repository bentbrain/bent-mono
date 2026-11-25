import type { ExpoConfig } from "expo/config";
import { appSettings, resolveVariant } from "./src/config/variants.ts";

// Expo's TypeScript setup otherwise installs packages on start.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

const variant = resolveVariant(process.env.APP_VARIANT);
const settings = appSettings(variant, process.env);

const config: ExpoConfig = {
  name: settings.name,
  slug: "fitness-sync",
  version: "1.0.0",
  scheme: settings.scheme,
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  platforms: ["ios"],
  ios: {
    bundleIdentifier: settings.bundleIdentifier,
    buildNumber: "1",
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
          NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
        },
      ],
      NSPrivacyCollectedDataTypes: [
        {
          NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeHealth",
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
        },
        {
          NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeFitness",
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
        },
      ],
    },
  },
  plugins: [
    [
      "./modules/fitness-health/app.plugin.js",
      {
        fitnessOrigin: settings.fitnessOrigin,
        allowLocalNetworking: settings.allowLocalNetworking,
      },
    ],
  ],
  extra: {
    variant,
    fitnessOrigin: settings.fitnessOrigin,
    oauth: settings.oauth,
    eas: { projectId: "50ba8677-0be0-45a5-ac8c-ceff89d65696" },
  },
};

export default config;
