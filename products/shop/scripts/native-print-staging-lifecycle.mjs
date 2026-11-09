import { isDeepStrictEqual } from "node:util";
import { CLOUDFLARE_ACCOUNT, developmentCloudflare } from "./native-ci-cloudflare.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { productionCloudflare } from "./native-production-cloudflare.mjs";

const check = (value, message) => { if (!value) throw new Error(`Print staging lifecycle stopped: ${message}`); };
export function printStagingLifecycleProtocol(environment) {
  check(["development", "production"].includes(environment), "exact executor environment required.");
  const bucket = `forever-tee-design-artwork-${environment}`;
  const rule = { id: `expire-${environment}-print-staging-after-one-day`, enabled: true,
  conditions: { prefix: "print-assets/staging/v1/" },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } } };

function planPrintStagingLifecycle(before) {
  check(Array.isArray(before?.rules) && before.rules.length < 100 &&
    before.rules.every(item => typeof item.id === "string" && item.id.length > 0) &&
    new Set(before.rules.map(item => item.id)).size === before.rules.length, "bounded existing rules required.");
  const matches = before.rules.filter(item => item.id === rule.id);
  check(matches.length === 0 || isDeepStrictEqual(matches[0], rule), "existing managed rule differs; it cannot be overwritten.");
  return { schemaVersion: 1, bucket, before: structuredClone(before),
    after: { ...structuredClone(before), rules: matches.length ? structuredClone(before.rules) : [...structuredClone(before.rules), structuredClone(rule)] },
    mutationRequired: matches.length === 0 };
}

function verifyPrintStagingLifecyclePlan(plan) {
  check(isDeepStrictEqual(plan, planPrintStagingLifecycle(plan.before)), "only the exact scoped append is authorized.");
  return true;
}

function verifyPrintStagingLifecycle(current, plan) {
  verifyPrintStagingLifecyclePlan(plan);
  check(isDeepStrictEqual(current, plan.after), "lifecycle readback changed or removed an existing rule.");
  return true;
}

function client(env, request = fetch) {
  if (environment === "production") productionCloudflare(env, request);
  else developmentCloudflare(env, request);
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/r2/buckets/${bucket}/lifecycle`;
  const call = async (method, body) => {
    let response;
    try { response = await request(url, { method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new Error("Print staging lifecycle response was not confirmed; inspect before retrying."); }
    check(response.ok, `HTTP ${response.status}; no response details logged.`);
    let value;
    try { value = await response.json(); }
    catch { throw new Error("Print staging lifecycle returned invalid JSON; no response details logged."); }
    check(value.success === true, "provider did not confirm the lifecycle operation.");
    return value.result;
  };
  const read = () => call("GET");
  return { read,
    append: async plan => {
      const selected = environment === "production" ? env.NATIVE_OPERATION : developmentOperation(env);
      check(selected === "release" || environment === "development" && selected === "recover-forward-release" && plan.mutationRequired === false, "only the guarded first-attempt release may append the rule.");
      verifyPrintStagingLifecyclePlan(plan);
      check(isDeepStrictEqual(await read(), plan.before), "live rules changed after review; no update performed.");
      if (plan.mutationRequired) await call("PUT", plan.after);
      const after = await read();
      verifyPrintStagingLifecycle(after, plan);
      return after;
    } };
}

  return { client, planPrintStagingLifecycle, verifyPrintStagingLifecycle, verifyPrintStagingLifecyclePlan };
}

export const { client: developmentPrintStagingLifecycle, planPrintStagingLifecycle,
  verifyPrintStagingLifecycle, verifyPrintStagingLifecyclePlan } = printStagingLifecycleProtocol("development");
