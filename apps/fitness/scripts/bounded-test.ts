// Runs `bun test` with this same Bun binary and stops it at a wall-clock
// deadline. The limit is enforced from outside the test process, so a test
// that blocks its own event loop still ends.
import { deadlineMs } from "../tests/deadline";

const limit = deadlineMs();
const child = Bun.spawn([process.execPath, "test", ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
});
let expired = false;
const timer = setTimeout(() => {
  expired = true;
  console.error(
    `Fitness tests were still running after ${Math.round(limit / 1000)} s, so the run was stopped. Set FITNESS_TEST_DEADLINE_MS to allow longer.`,
  );
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
}, limit);
const code = await child.exited;
clearTimeout(timer);
process.exit(expired ? 1 : code);
