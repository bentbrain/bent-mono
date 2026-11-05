import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const env = process.env;
if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "bentbrain/bent-mono" || env.GITHUB_REF !== "refs/heads/main") throw new Error("Use the main-branch Product lifecycle Actions workflow.");
const environment = env.OPERATIONS_ENVIRONMENT;
if (!["development", "production"].includes(environment)) throw new Error("Choose an environment.");
const url = new URL("/v2/internal/operations/product-lifecycle", env.WORKER_URL);
if (url.protocol !== "https:") throw new Error("HTTPS Worker required.");
if (!["inspect", "transition"].includes(env.OPERATION)) throw new Error("Choose an operation.");
const inspect = env.OPERATION === "inspect";
const storefront = inspect ? undefined : new URL("/api/internal/revalidate-products", env.WEB_ORIGIN);
if (!inspect && (storefront.protocol !== "https:" || !env.FOREVER_TEE_API_SHARED_SECRET)) throw new Error("Storefront invalidation configuration missing.");
if (!env.BENT_SHIRT_OPERATIONS_SECRET) throw new Error("Operations authentication missing.");
const productId = env.CONFIGURED_PRODUCT_ID;
const method = inspect ? "GET" : "POST";
const body = inspect ? "" : JSON.stringify({
  commandId: env.COMMAND_ID || randomUUID(), productId,
  from: env.EXPECTED_STATE, to: env.TARGET_STATE,
  reason: env.REASON, confirmation: env.CONFIRMATION,
});
if (inspect) url.searchParams.set("productId", productId);
// Save exact input before dispatch. A failed/uncertain response must be
// inspected using this command ID, never retried with a replacement ID.
await writeFile("product-lifecycle-request.json", body || JSON.stringify({ productId, operation: "inspect" }), { flag: "wx" });
const digest = createHash("sha256").update(body).digest("hex");
const audience = `bent-shirt:operations:${environment}:${method}:${url.pathname}:${digest}`;
const identityUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
identityUrl.searchParams.set("audience", audience);
const identityResponse = await fetch(identityUrl, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15000) });
if (!identityResponse.ok) throw new Error("GitHub workflow identity unavailable.");
const identity = await identityResponse.json();
if (typeof identity.value !== "string" || !identity.value) throw new Error("Missing workflow identity.");
const response = await fetch(url, {
  method, ...(inspect ? {} : { body }), redirect: "error", signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${identity.value}`, "content-type": "application/json", "x-bent-shirt-operations-secret": env.BENT_SHIRT_OPERATIONS_SECRET },
});
const result = await response.json();
await writeFile("product-lifecycle-result.json", JSON.stringify({ status: response.status, result }), { flag: "wx" });
console.info(JSON.stringify({ status: response.status, result }));
if (!response.ok) process.exitCode = 1;

if (response.ok && !inspect) {
  const headers = { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET };
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const invalidated = await fetch(storefront, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(30000) });
  await writeFile("product-lifecycle-cache.json", JSON.stringify({ status: invalidated.status }), { flag: "wx" });
  if (!invalidated.ok) throw new Error("Product transition committed but storefront cache invalidation failed. Recover using the saved command ID.");
}
