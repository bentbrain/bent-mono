import { sealReleaseEvidence, openReleaseEvidence } from "./release-evidence.mjs";

const fields = new Map([
  ["promotion_input", "NATIVE_PROMOTION_INPUT"], ["qualification_reference", "NATIVE_QUALIFICATION_REFERENCE"],
  ["completion_reference", "NATIVE_COMPLETION_REFERENCE"],
  ["forward_recovery_reference", "NATIVE_FORWARD_RECOVERY_REFERENCE"],
  ["renderer_reference", "NATIVE_RENDERER_REFERENCE"], ["rollback_reference", "NATIVE_ROLLBACK_REFERENCE"],
]);
function originalRun(value, field) {
  if (field === "promotion_input") return String(value.qualification?.qualificationRunId ?? "");
  if (["forward_recovery_reference", "completion_reference"].includes(field)) return /^source\/releases\/native-([1-9][0-9]*)\//.exec(value.authority?.key ?? "")?.[1] ?? "";
  const key = value.key;
  return /-run-([1-9][0-9]*)\.json$/.exec(key ?? "")?.[1] ?? /^source\/releases\/native-([1-9][0-9]*)\/rollback\.json$/.exec(key ?? "")?.[1] ?? "";
}
export function sealDispatchInputs(inputs, sourceCommit, env = process.env) {
  const output = { ...inputs };
  for (const [field] of fields) {
    if (!output[field]) continue;
    const value = JSON.parse(output[field]);
    output[field] = sealReleaseEvidence(value, { sourceCommit, runId: originalRun(value, field), filename: `${field.replaceAll("_", "-")}.json` }, env);
  }
  return output;
}
export function resolveDispatchInputs(env) {
  for (const [field, name] of fields) {
    if (!env[name]) continue;
    const header = JSON.parse(env[name]);
    const value = openReleaseEvidence(env[name], { sourceCommit: env.GITHUB_SHA, runId: header.runId, filename: `${field.replaceAll("_", "-")}.json` }, env);
    if (originalRun(value, field) !== header.runId) throw new Error("Submitted evidence differs from its original run.");
    env[name] = JSON.stringify(value);
  }
}
