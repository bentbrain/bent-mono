// Native settings for the workout Live Activity and the Today widget: the
// app's Live Activities Info.plist key, and a widget extension target that
// compiles the Swift in this module's ios/Extension and ios/Shared folders
// where they are, so the generated project holds only the extension's
// Info.plist and entitlements. ActivityKit passes the activity's content to
// the extension directly. The Today widget reads the snapshot the app writes
// to their shared App Group, `group.` followed by the app's bundle ID, which
// both Info.plists name under `FitnessAppGroup`.
const { withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const targetName = "WorkoutActivityExtension";
const sources = [
  "Extension/WorkoutActivityWidget.swift",
  "Extension/TodayWidget.swift",
  "Shared/WorkoutActivityAttributes.swift",
  "Shared/TodaySnapshot.swift",
];
const deploymentTarget = "16.4";
const appGroupsKey = "com.apple.security.application-groups";
const entitlementsFile = `${targetName}.entitlements`;

/** The extension's bundle ID: the app's, followed by `.workout-activity`. */
function extensionBundleId(config) {
  const app = config.ios?.bundleIdentifier;
  if (!app) throw new Error("workout-activity needs ios.bundleIdentifier.");
  return `${app}.workout-activity`;
}

/** The App Group the app and the extension share: `group.` followed by the app's bundle ID. */
function appGroup(config) {
  const app = config.ios?.bundleIdentifier;
  if (!app) throw new Error("workout-activity needs ios.bundleIdentifier.");
  return `group.${app}`;
}

/** The extension's entitlements: the shared App Group only. */
function entitlementsPlist(group) {
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>${appGroupsKey}</key>
  <array>
    <string>${escape(group)}</string>
  </array>
</dict>
</plist>
`;
}

/** The extension's Info.plist, with the app's version and build number and the App Group. */
function infoPlist(version, buildNumber, group) {
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>Workout</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>${escape(version)}</string>
  <key>CFBundleVersion</key>
  <string>${escape(buildNumber)}</string>
  <key>FitnessAppGroup</key>
  <string>${escape(group)}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`;
}

/** The build phase of `type` on the target, if it has one. */
function buildPhase(project, type, targetUuid, comment) {
  const section = project.hash.project.objects[type];
  const target = project.pbxNativeTargetSection()[targetUuid];
  const phase = target?.buildPhases?.find((item) => (!comment || item.comment === comment) && section?.[item.value]);
  return phase ? section[phase.value] : undefined;
}

/** Adds the extension target to the app's Xcode project, once. */
function addExtensionTarget(project, { bundleId, version, buildNumber, moduleDir, iosDir }) {
  if (project.pbxTargetByName(targetName)) return;
  const groupDir = path.join(iosDir, targetName);
  const files = sources.map((file) => path.relative(groupDir, path.join(moduleDir, "ios", file)).split(path.sep).join("/"));

  const settings = {
    PRODUCT_NAME: '"$(TARGET_NAME)"',
    PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}"`,
    INFOPLIST_FILE: `${targetName}/Info.plist`,
    CODE_SIGN_ENTITLEMENTS: `${targetName}/${entitlementsFile}`,
    GENERATE_INFOPLIST_FILE: "NO",
    MARKETING_VERSION: `"${version}"`,
    CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
    IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
    TARGETED_DEVICE_FAMILY: '"1"',
    SWIFT_VERSION: "5.0",
    SKIP_INSTALL: "YES",
    APPLICATION_EXTENSION_API_ONLY: "YES",
    LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
  };
  const configurations = project.addXCConfigurationList(
    ["Debug", "Release"].map((name) => ({ name, isa: "XCBuildConfiguration", buildSettings: { ...settings } })),
    "Release",
    `Build configuration list for PBXNativeTarget "${targetName}"`,
  );

  const product = project.addProductFile(targetName, {
    basename: `${targetName}.appex`,
    group: "Embed Foundation Extensions",
    explicitFileType: "wrapper.app-extension",
    settings: { ATTRIBUTES: ["RemoveHeadersOnCopy"] },
    includeInIndex: 0,
    path: `${targetName}.appex`,
    sourceTree: "BUILT_PRODUCTS_DIR",
  });
  const target = {
    uuid: project.generateUuid(),
    pbxNativeTarget: {
      isa: "PBXNativeTarget",
      name: targetName,
      productName: targetName,
      productReference: product.fileRef,
      productType: '"com.apple.product-type.app-extension"',
      buildConfigurationList: configurations.uuid,
      buildPhases: [],
      buildRules: [],
      dependencies: [],
    },
  };
  project.addToPbxNativeTargetSection(target);
  project.addToPbxProjectSection(target);
  const attributes = project.pbxProjectSection()[project.getFirstProject().uuid].attributes;
  attributes.TargetAttributes = { ...(attributes.TargetAttributes ?? {}), [target.uuid]: { CreatedOnToolsVersion: "16.0" } };
  const app = project.getFirstTarget().uuid;
  project.addTargetDependency(app, [target.uuid]);

  // The extension's sources, in a group that points at this module.
  const group = project.addPbxGroup([...files, "Info.plist", entitlementsFile], targetName, targetName);
  const main = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, main);
  // The xcode package writes unset file properties as "undefined"; leave them out.
  const references = project.pbxFileReferenceSection();
  for (const ref of [product.fileRef, ...group.pbxGroup.children.map((child) => child.value)]) {
    const entry = references[ref];
    if (entry && typeof entry === "object")
      for (const key of Object.keys(entry)) if (entry[key] === undefined || entry[key] === "undefined") delete entry[key];
  }
  project.addBuildPhase(files, "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);

  // The app embeds the extension in PlugIns.
  const embed = "Embed Foundation Extensions";
  if (!buildPhase(project, "PBXCopyFilesBuildPhase", app, embed))
    project.addBuildPhase([], "PBXCopyFilesBuildPhase", embed, app, "app_extension");
  const copy = buildPhase(project, "PBXCopyFilesBuildPhase", app, embed);
  project.addToPbxBuildFileSection(product);
  copy.files.push({ value: product.uuid, comment: `${product.basename} in ${embed}` });
}

/** @type {import("expo/config-plugins").ConfigPlugin} */
function withWorkoutActivity(config) {
  const bundleId = extensionBundleId(config);
  const version = config.ios?.version ?? config.version ?? "1.0.0";
  const buildNumber = config.ios?.buildNumber ?? "1";
  const group = appGroup(config);

  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSSupportsLiveActivities = true;
    mod.modResults.FitnessAppGroup = group;
    return mod;
  });

  // The app writes the widget's snapshot to the App Group's container.
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults[appGroupsKey] = [group];
    return mod;
  });

  // EAS Build signs the extension with its own App Store profile, which
  // carries the App Group.
  const ios = config.extra?.eas?.build?.experimental?.ios ?? {};
  const extensions = (ios.appExtensions ?? []).filter((item) => item.targetName !== targetName);
  config.extra = {
    ...config.extra,
    eas: {
      ...config.extra?.eas,
      build: {
        ...config.extra?.eas?.build,
        experimental: {
          ...config.extra?.eas?.build?.experimental,
          ios: { ...ios, appExtensions: [...extensions, { targetName, bundleIdentifier: bundleId, entitlements: { [appGroupsKey]: [group] } }] },
        },
      },
    },
  };

  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const dir = path.join(mod.modRequest.platformProjectRoot, targetName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "Info.plist"), infoPlist(version, buildNumber, group));
      fs.writeFileSync(path.join(dir, entitlementsFile), entitlementsPlist(group));
      return mod;
    },
  ]);

  config = withXcodeProject(config, (mod) => {
    addExtensionTarget(mod.modResults, {
      bundleId,
      version,
      buildNumber,
      moduleDir: __dirname,
      iosDir: mod.modRequest.platformProjectRoot,
    });
    return mod;
  });
  return config;
}

module.exports = withWorkoutActivity;
module.exports.extensionBundleId = extensionBundleId;
module.exports.appGroup = appGroup;
module.exports.targetName = targetName;
