import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../scripts/test-protected-config.mjs"],
    // Each Workerd-backed file owns local D1/R2 emulators and many HTTP round trips.
    // Serial files bound CPU contention and ephemeral-port use without changing deadlines.
    maxWorkers: 1,
  },
});
