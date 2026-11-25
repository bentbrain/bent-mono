// The contract round trip between the Swift client and the Fitness server:
// Swift encodes requests, the real Fitness handlers answer them against
// Postgres, and Swift decodes the answers. Needs FITNESS_TEST_DATABASE_URL.
//
//   FITNESS_TEST_DATABASE_URL=postgres://... node scripts/roundtrip.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const core = join(app, "modules/fitness-health/ios");
const fitness = resolve(app, "../fitness");
// Build output stays in this user's caches unless NATIVE_BUILD_DIR names another place.
const buildDir = resolve(process.env.NATIVE_BUILD_DIR || join(homedir(), "Library/Caches/fitness-ios-build"));
if (!process.env.FITNESS_TEST_DATABASE_URL) {
  console.error("Set FITNESS_TEST_DATABASE_URL to a Postgres database for the round trip.");
  process.exit(2);
}

function run(command, args, cwd, env) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const wire = mkdtempSync(join(tmpdir(), "fitness-ios-wire-"));
try {
  const swift = (pass) =>
    run("swift", ["test", "--scratch-path", join(buildDir, "core"), "--filter", "RoundTripTests"], core, {
      FITNESS_WIRE_DIR: wire,
      FITNESS_WIRE_PASS: pass,
    });
  swift("encode");
  run("bun", ["test", "tests/ios-roundtrip.test.ts"], fitness, { FITNESS_IOS_WIRE_DIR: wire });
  swift("decode");
  console.log("Round trip: Swift requests and Fitness replies agree.");
} finally {
  rmSync(wire, { recursive: true, force: true });
}
