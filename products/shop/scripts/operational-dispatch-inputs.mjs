import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sealReleaseEvidence, openReleaseEvidence } from "./release-evidence.mjs";
import { protectedConfig } from "./protected-config.mjs";

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sha = value => /^[a-f0-9]{40}$/.test(value);
const text = value => typeof value === "string";
const optional = validate => value => value === "" || validate(value);
const states = values => value => values.includes(value);
const field = (name, validate, defaultValue = "") => ({ name, validate, defaultValue });
// Public inputs are bounded selectors. Record fields are authenticated together,
// then assigned only to the fixed consumer variables below, never arbitrary env.
export const operationalSchemas = Object.freeze({
  "operations.yml": { selector: "action", operations: ["read-sales-status", "pause-sales", "refresh-catalogue", "refresh-print-assets", "refresh-variant-mapping", "resume-sales"], fields: {
    reason: field("REASON", optional(text)), configured_product_id: field("CONFIGURED_PRODUCT_ID", optional(uuid)),
  } },
  "product-lifecycle.yml": { selector: "operation", operations: ["inspect", "transition"], fields: {
    configured_product_id: field("CONFIGURED_PRODUCT_ID", uuid), expected_state: field("EXPECTED_STATE", optional(states(["active", "suspended", "unpublished"]))),
    target_state: field("TARGET_STATE", optional(states(["suspended", "active", "unpublished", "retired"]))), reason: field("REASON", optional(text)),
    confirmation: field("CONFIRMATION", optional(text)), command_id: field("COMMAND_ID", optional(uuid)),
  } },
  "featured-products.yml": { selector: "operation", operations: ["inspect", "replace"], fields: {
    expected_revision: field("EXPECTED_REVISION", optional(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))), command_id: field("COMMAND_ID", optional(uuid)),
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`slot_${i + 1}`, field(`SLOT_${i + 1}`, optional(value => uuid(value.trim())))])),
  } },
  "featured-video.yml": { fields: { final_product: field("FINAL_PRODUCT", value => value.trim() === "" || /^[1-6]$/.test(value.trim()) || uuid(value.trim()), "1") } },
  "featured-composition.yml": { owner: true, selector: "operation", operations: ["create", "recover", "cleanup"], fields: {
    native_release: field("COMPOSITION_NATIVE_RELEASE", value => /^native-[1-9][0-9]+$/.test(value)),
    qualified_source: field("COMPOSITION_QUALIFIED_SOURCE", optional(sha)), cleanup_source: field("COMPOSITION_CLEANUP_SOURCE", optional(sha)),
  } },
  "backup-renderer.yml": { owner: true, selector: "operation", operations: ["deploy", "recover"], fields: { recovery_source: field("BACKUP_RECOVERY_SOURCE", optional(sha)) } },
  "configure-printify-webhooks.yml": { selector: "operation", operations: ["plan", "apply"], production: true, fields: {} },
});
const stop = () => { throw new Error("Shop operational input or protected workflow identity is invalid; no operation started."); };
function selectors(workflow, environment, operation) {
  const schema = operationalSchemas[workflow];
  if (!schema || !["development", "production"].includes(environment) || schema.production && environment !== "production" ||
      (schema.selector ? !schema.operations.includes(operation) : operation !== "render")) stop();
  return schema;
}
function record(schema, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(schema.fields, key))) stop();
  const normalized = {};
  for (const [key, specification] of Object.entries(schema.fields)) {
    const input = Object.hasOwn(value, key) ? value[key] : specification.defaultValue;
    if (typeof input !== "string" || !specification.validate(input)) stop();
    normalized[key] = input;
  }
  return normalized;
}
export function sealOperationalInput({ workflow, environment, operation, sourceCommit, inputs }, env = process.env) {
  const schema = selectors(workflow, environment, operation);
  if (!sha(sourceCommit) || !Object.keys(schema.fields).length) stop();
  // A dispatch has no Actions run yet. Use a random transport identity in the
  // existing evidence envelope and authenticate it inside the typed request.
  // This nonce grants no replay authority; consumer command/intent fences apply.
  const requestId = BigInt(`0x${randomBytes(16).toString("hex")}`).toString();
  const payload = { schemaVersion: 1, purpose: "shop-operational-dispatch", workflow, environment, operation, sourceCommit, requestId, inputs: record(schema, inputs) };
  return sealReleaseEvidence(payload, { sourceCommit, runId: requestId, filename: `${workflow.slice(0, -4)}-input.json` }, env);
}
export function validateOperationalDispatch(env, event) {
  const workflow = /^bentbrain\/bent-mono\/\.github\/workflows\/([a-z-]+\.yml)@refs\/heads\/main$/.exec(env.GITHUB_WORKFLOW_REF ?? "")?.[1];
  const environment = event.inputs?.environment ?? "production";
  const schema = operationalSchemas[workflow];
  const operation = schema?.selector ? event.inputs?.[schema.selector] : "render";
  selectors(workflow, environment, operation);
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" || env.GITHUB_REPOSITORY !== "bentbrain/bent-mono" ||
      env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") || env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") ||
      env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_RUN_ATTEMPT !== "1" ||
      env.GITHUB_WORKFLOW_REF !== `bentbrain/bent-mono/.github/workflows/${workflow}@refs/heads/main` ||
      !sha(env.GITHUB_SHA) || event.inputs?.expected_source !== env.GITHUB_SHA || !["main", "refs/heads/main"].includes(event.ref) ||
      env.SHOP_OPERATION_ENVIRONMENT !== (environment === "production" ? "Production" : "Preview") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_ACTOR_ID ?? "") || schema.owner && env.GITHUB_ACTOR_ID !== protectedConfig("githubOwnerId")) stop();
  const allowed = new Set(["expected_source", ...(schema.production ? [] : ["environment"]), ...(schema.selector ? [schema.selector] : ["color"]), ...(Object.keys(schema.fields).length ? ["private_input"] : [])]);
  if (!event.inputs || Object.keys(event.inputs).some(key => !allowed.has(key)) || workflow === "featured-video.yml" && !["default", "black", "white", "cream"].includes(event.inputs.color)) stop();
  if (!schema.production && !Object.hasOwn(event.inputs, "environment")) stop();
  let inputs = {};
  if (Object.keys(schema.fields).length) {
    const encoded = event.inputs.private_input;
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 16384) stop();
    let payload;
    try {
      const header = JSON.parse(encoded);
      payload = openReleaseEvidence(encoded, { sourceCommit: env.GITHUB_SHA, runId: header.runId, filename: `${workflow.slice(0, -4)}-input.json` }, env);
      if (Object.keys(payload).sort().join() !== ["schemaVersion", "purpose", "workflow", "environment", "operation", "sourceCommit", "requestId", "inputs"].sort().join() ||
          payload.schemaVersion !== 1 || payload.purpose !== "shop-operational-dispatch" || payload.workflow !== workflow || payload.environment !== environment ||
          payload.operation !== operation || payload.sourceCommit !== env.GITHUB_SHA || payload.requestId !== header.runId) stop();
      inputs = record(schema, payload.inputs);
    } catch { stop(); }
  }
  return { workflow, environment, operation, inputs };
}
export async function resolveOperationalDispatch(env = process.env) {
  const request = validateOperationalDispatch(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")));
  const publicVariables = {
    "operations.yml": { ACTION: request.operation },
    "product-lifecycle.yml": { OPERATIONS_ENVIRONMENT: request.environment, OPERATION: request.operation },
    "featured-products.yml": { OPERATIONS_ENVIRONMENT: request.environment, OPERATION: request.operation },
    "featured-video.yml": { RENDER_ENVIRONMENT: request.environment },
    "featured-composition.yml": { COMPOSITION_ENVIRONMENT: request.environment, COMPOSITION_OPERATION: request.operation },
    "backup-renderer.yml": { BACKUP_ENVIRONMENT: request.environment, BACKUP_OPERATION: request.operation },
    "configure-printify-webhooks.yml": { PRINTIFY_WEBHOOK_OPERATION: request.operation },
  };
  Object.assign(env, publicVariables[request.workflow]);
  for (const [key, value] of Object.entries(request.inputs)) env[operationalSchemas[request.workflow].fields[key].name] = value;
  return request;
}
