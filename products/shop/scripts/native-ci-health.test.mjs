import assert from "node:assert/strict";
import test from "node:test";
import { verifyStartupProbe } from "./native-ci-health.mjs";

test("live startup probes require a real handler validation error, not merely an accepted invocation", () => {
  const result = { StatusCode: 200, FunctionError: "Unhandled", ExecutedVersion: "$LATEST" };
  const payload = { errorType: "Error", errorMessage: "Invalid app job." };
  assert.equal(verifyStartupProbe(result, payload).realRuntimeStarted, true);
  assert.equal(verifyStartupProbe(result, { ...payload, errorMessage: "Expected the personal failure-queue Lambda." }, true).handler, "failure");
  for (const altered of [{ ...result, StatusCode: 202 }, { ...result, FunctionError: undefined }, { ...result, ExecutedVersion: "unreviewed" }]) {
    assert.throws(() => verifyStartupProbe(altered, payload));
  }
  for (const altered of [{ errorType: "Runtime.ExitError", errorMessage: "Permission denied" },
    { errorType: "Error", errorMessage: "Task timed out" }, { ok: true }]) assert.throws(() => verifyStartupProbe(result, altered));
  assert.throws(() => verifyStartupProbe(result, payload, true));
});
