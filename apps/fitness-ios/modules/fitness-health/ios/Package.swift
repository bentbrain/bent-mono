// swift-tools-version: 6.0
// The sync engine's platform-independent core, built and tested on its own.
// The app compiles the same sources through FitnessHealth.podspec.
import PackageDescription

let package = Package(
  name: "FitnessHealthCore",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "FitnessHealthCore", targets: ["FitnessHealthCore"])
  ],
  targets: [
    .target(name: "FitnessHealthCore", path: "Core"),
    .testTarget(
      name: "FitnessHealthCoreTests",
      dependencies: ["FitnessHealthCore"],
      path: "Tests"
    ),
  ]
)
