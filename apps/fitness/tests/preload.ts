// Loaded before every `bun test` run started in apps/fitness (see bunfig.toml).
//
// Earlier Bun releases can leave the integration suite running forever after a
// test times out with a database pool still open, so the tests require the
// repository's pinned Bun. The package scripts also enforce a wall-clock
// deadline from outside the test process (scripts/bounded-test.ts); the timer
// here is a best-effort limit for `bun test` started directly.
import { deadlineMs } from "./deadline";

// Bun.semver treats prereleases such as 1.4.4-canary.1 as earlier than 1.4.4.
if (!Bun.semver.satisfies(Bun.version, ">=1.4.4")) {
  console.error(
    `Fitness tests need Bun 1.4.4 or later; this is Bun ${Bun.version}. Run them with the repository's pinned Bun.`,
  );
  process.exit(1);
}

const limit = deadlineMs();
setTimeout(() => {
  console.error(
    `Fitness tests were still running after ${Math.round(limit / 1000)} s, so the run was stopped. Set FITNESS_TEST_DEADLINE_MS to allow longer.`,
  );
  process.exit(1);
}, limit).unref();
