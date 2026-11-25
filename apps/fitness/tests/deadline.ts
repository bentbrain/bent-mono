const defaultMs = 15 * 60_000;
const maxMs = 2_147_483_647;

/**
 * The test deadline in milliseconds. `FITNESS_TEST_DEADLINE_MS` overrides it
 * with a whole number from 1 through 2147483647; anything else is an error,
 * so a mistyped override cannot end a healthy run early.
 */
export function deadlineMs(value = process.env.FITNESS_TEST_DEADLINE_MS) {
  if (value === undefined) return defaultMs;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > maxMs) {
    console.error(
      `FITNESS_TEST_DEADLINE_MS must be a whole number of milliseconds from 1 through ${maxMs}; it is "${value}".`,
    );
    process.exit(1);
  }
  return Number(value);
}
