import { NAME } from "./config.mjs";
import { verifyFunction } from "./benchmark-core.mjs";

export function verifySmokeCapacity(account, fn, reservation, metrics) {
  verifyFunction(fn);
  const available = account.AccountLimit?.UnreservedConcurrentExecutions;
  if (fn.capacityMode !== "sequential-smoke" || reservation?.ReservedConcurrentExecutions !== undefined ||
      !Number.isInteger(available) || available < 2 || !Array.isArray(metrics.Datapoints)) {
    throw new Error("Expected sequential-smoke mode with at least two unreserved slots.");
  }
  const maxima = metrics.Datapoints.map((point) => point.Maximum);
  if (maxima.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid account concurrency evidence.");
  const observedMaximum = maxima.length ? Math.max(...maxima) : null;
  if (observedMaximum !== null && observedMaximum >= available - 1) {
    throw new Error("Recent account activity leaves insufficient headroom for a smoke invocation.");
  }
  return { unreservedLimit: available, observedMaximum,
    note: "CloudWatch is delayed; missing metrics are unknown, not zero. One invocation only, no isolation guarantee." };
}

export async function smokePreflight(call, now = Date.now()) {
  const account = await call(["lambda", "get-account-settings"]);
  const fn = await call(["lambda", "get-function", "--function-name", NAME, "--query",
    "{arn:Configuration.FunctionArn,state:Configuration.State,update:Configuration.LastUpdateStatus,memoryMB:Configuration.MemorySize,buildId:Configuration.Environment.Variables.STORY_BUILD_ID,capacityMode:Configuration.Environment.Variables.STORY_CAPACITY_MODE,image:Code.ResolvedImageUri}"]);
  const reservation = await call(["lambda", "get-function-concurrency", "--function-name", NAME]);
  const metrics = await call(["cloudwatch", "get-metric-statistics", "--namespace", "AWS/Lambda",
    "--metric-name", "UnreservedConcurrentExecutions", "--start-time", new Date(now - 15 * 60_000).toISOString(),
    "--end-time", new Date(now).toISOString(), "--period", "60", "--statistics", "Maximum"]);
  return { fn, capacity: verifySmokeCapacity(account, fn, reservation, metrics) };
}

export async function sequentialJobs(jobs, invoke, onResult = () => {}) {
  const results = [];
  for (const job of jobs) {
    const result = await invoke(job);
    results.push(result);
    await onResult(result);
  }
  return results;
}
