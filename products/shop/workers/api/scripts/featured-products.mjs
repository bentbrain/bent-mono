import { protectedConfig } from "../../../scripts/protected-config.mjs";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const env = process.env;
if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "bentbrain/bent-mono" ||
    env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") || env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_RUN_ATTEMPT !== "1" || env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.GITHUB_WORKFLOW_REF !== "bentbrain/bent-mono/.github/workflows/featured-products.yml@refs/heads/main") {
    throw new Error("Use a new main-branch Featured designs Actions run.");
}
const environment = env.OPERATIONS_ENVIRONMENT;
if (!["development", "production"].includes(environment))
    throw new Error("Choose an environment.");
if (!["inspect", "replace"].includes(env.OPERATION))
    throw new Error("Choose inspect or replace.");
const inspect = env.OPERATION === "inspect";
if (!inspect && env.GITHUB_ACTOR_ID !== protectedConfig("githubOwnerId"))
    throw new Error("Only the owner can replace featured designs.");
if (!env.BENT_SHIRT_OPERATIONS_SECRET)
    throw new Error("Operations authentication missing.");
const url = new URL("/v2/internal/operations/featured-products", env.WORKER_URL);
if (url.protocol !== "https:")
    throw new Error("HTTPS Worker required.");
const products = Array.from({ length: 6 }, (_, index) => ({ slot: index + 1, productId: env[`SLOT_${index + 1}`]?.trim() })).filter(product => product.productId);
const expectedRevision = Number(env.EXPECTED_REVISION);
if (!inspect && (!/^\d+$/.test(env.EXPECTED_REVISION ?? "") || !Number.isSafeInteger(expectedRevision) || products.length === 0 ||
    products.some(product => !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(product.productId)) ||
    new Set(products.map(product => product.productId)).size !== products.length))
    throw new Error("Supply an inspected revision and distinct configured product UUIDs.");
const method = inspect ? "GET" : "POST";
const body = inspect ? "" : JSON.stringify({ products, expectedRevision, commandId: env.COMMAND_ID || randomUUID() });
// Save before dispatch. Recover an uncertain write with this same request and command ID.
await writeFile("featured-products-request.json", body || JSON.stringify({ operation: "inspect" }), { flag: "wx" });
const digest = createHash("sha256").update(body).digest("hex");
const identityUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
identityUrl.searchParams.set("audience", `bent-shirt:operations:${environment}:${method}:${url.pathname}:${digest}`);
const identityResponse = await fetch(identityUrl, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
if (!identityResponse.ok)
    throw new Error("GitHub workflow identity unavailable.");
const identity = await identityResponse.json();
if (typeof identity.value !== "string" || !identity.value)
    throw new Error("Missing workflow identity.");
const response = await fetch(url, { method, ...(inspect ? {} : { body }), redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${identity.value}`, "content-type": "application/json", "x-bent-shirt-operations-secret": env.BENT_SHIRT_OPERATIONS_SECRET },
});
const result = await response.json();
await writeFile("featured-products-result.json", JSON.stringify({ status: response.status, result }), { flag: "wx" });
console.info(JSON.stringify({ status: response.status, result }));
if (!response.ok)
    process.exitCode = 1;
