// Runs `bun test` with this same Bun binary and stops it at a wall-clock
// deadline. The limit is enforced from outside the test process, so a test
// that blocks its own event loop still ends. SIGINT and SIGTERM sent to this
// runner are passed on to the tests, and the runner stays until they exit.
import { deadlineMs } from "../tests/deadline";

const graceMs = 5_000;
const limit = deadlineMs();
const child = Bun.spawn([process.execPath, "test", ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
});

let expired = false;
let cancelled: "SIGINT" | "SIGTERM" | undefined;
let escalation: ReturnType<typeof setTimeout> | undefined;
function stop(signal: "SIGINT" | "SIGTERM") {
  child.kill(signal);
  escalation ??= setTimeout(() => child.kill("SIGKILL"), graceMs);
}

const timer = setTimeout(() => {
  expired = true;
  console.error(
    `Fitness tests were still running after ${Math.round(limit / 1000)} s, so the run was stopped. Set FITNESS_TEST_DEADLINE_MS to allow longer.`,
  );
  stop("SIGTERM");
}, limit);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    cancelled ??= signal;
    stop(signal);
  });

const code = await child.exited;
clearTimeout(timer);
if (escalation) clearTimeout(escalation);
// A run that was stopped never counts as a pass, even when the tests exit 0
// after handling the signal.
const cancelledCode = cancelled === "SIGINT" ? 130 : 143;
process.exit(expired ? 1 : cancelled && code === 0 ? cancelledCode : code);
