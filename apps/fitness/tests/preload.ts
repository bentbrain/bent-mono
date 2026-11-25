// Loaded before every Fitness test file (see bunfig.toml).
//
// Earlier Bun releases can leave the integration suite running forever after a
// test times out with a database pool still open. So the suite requires the
// repository's pinned Bun, and every run ends by a fixed deadline instead of
// holding a CPU until someone stops it.

const [major = 0, minor = 0, patch = 0] = Bun.version
  .split(".")
  .map((part) => Number.parseInt(part, 10));
const older = major !== 1 ? major < 1 : minor !== 4 ? minor < 4 : patch < 4;
if (older) {
  console.error(
    `Fitness tests need Bun 1.4.4 or later; this is Bun ${Bun.version}. Run them with the repository's pinned Bun.`,
  );
  process.exit(1);
}

const limitMs = Number(process.env.FITNESS_TEST_DEADLINE_MS ?? 15 * 60_000);
setTimeout(() => {
  console.error(
    `Fitness tests were still running after ${Math.round(limitMs / 1000)} s, so the run was stopped. Set FITNESS_TEST_DEADLINE_MS to allow longer.`,
  );
  process.exit(1);
}, limitMs).unref();
