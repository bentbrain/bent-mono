import { protectedConfig } from "./protected-config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createHash } from "node:crypto";
const source = (await readFile(new URL("../workers/api/scripts/featured-products.mjs", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const productId = "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4";
const contextEnv = {
    GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_ACTOR_ID: protectedConfig("githubOwnerId"),
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/featured-products.yml@refs/heads/main",
    OPERATIONS_ENVIRONMENT: "production", OPERATION: "replace", WORKER_URL: "https://worker.example.com",
    BENT_SHIRT_OPERATIONS_SECRET: "fixture", ACTIONS_ID_TOKEN_REQUEST_URL: "https://identity.example.com/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-token",
    EXPECTED_REVISION: "0", SLOT_1: productId,
};
async function execute(overrides = {}, status = 200) {
    const writes = [], requests = [], process = { env: { ...contextEnv, ...overrides } };
    const context = vm.createContext({ protectedConfig, process, URL, AbortSignal, createHash, randomUUID: () => "12345678-1234-4234-8234-123456789012",
        writeFile: async (path, body, options) => { assert.equal(options.flag, "wx"); writes.push({ path, body }); },
        fetch: async (url, options) => {
            assert.equal(writes[0]?.path, "featured-products-request.json");
            requests.push({ url: String(url), options });
            return requests.length === 1 ? { ok: true, json: async () => ({ value: "signed-token" }) } : { ok: status === 200, status, json: async () => ({ revision: 1 }) };
        }, console: { info() { } },
    });
    await new vm.Script(`(async () => {${source}\n})()`).runInContext(context);
    return { writes, requests, process };
}
test("configuration writes are pinned to the first owner workflow run", async () => {
    for (const overrides of [{ GITHUB_ACTIONS: "false" }, { GITHUB_REF: "refs/heads/other" }, { GITHUB_REPOSITORY_ID: "42" }, { GITHUB_RUN_ATTEMPT: "2" }, { RUNNER_ENVIRONMENT: "self-hosted" }, { GITHUB_ACTOR_ID: "777" }, { GITHUB_WORKFLOW_REF: "other" }, { OPERATION: "unknown" }, { EXPECTED_REVISION: "" }, { SLOT_1: "invalid" }, { SLOT_2: productId }]) {
        await assert.rejects(execute(overrides));
    }
});
test("save the request before dispatch and bind identity to its exact body", async () => {
    const result = await execute();
    const body = result.writes[0].body, request = result.requests[1];
    assert.equal(request.options.body, body);
    assert.equal(request.options.method, "POST");
    assert.equal(new URL(result.requests[0].url).searchParams.get("audience"), `bent-shirt:operations:production:POST:/v2/internal/operations/featured-products:${createHash("sha256").update(body).digest("hex")}`);
    assert.equal(request.options.headers.Authorization, "Bearer signed-token");
    assert.equal(result.writes[1].path, "featured-products-result.json");
});
test("inspection sends no mutation and reports failed writes without retry", async () => {
    const inspection = await execute({ OPERATION: "inspect", GITHUB_ACTOR_ID: "777" });
    assert.equal(inspection.requests[1].options.method, "GET");
    assert.equal(inspection.requests[1].options.body, undefined);
    const failed = await execute({}, 409);
    assert.equal(failed.process.exitCode, 1);
    assert.equal(failed.requests.length, 2);
});
