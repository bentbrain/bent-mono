import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const config = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../workers/print-executor/wrangler.jsonc", import.meta.url), "utf8")));
test("print executor creates its namespace in a separate private Development Worker", () => {
    assert.equal(config.account_id, protectedConfig("cloudflareAccountId"));
    assert.equal(config.name, "forever-tee-print-executor-local");
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.routes, undefined);
    assert.equal(config.triggers, undefined);
    assert.equal(config.queues, undefined);
    assert.equal(config.d1_databases[0].database_id, undefined);
    assert.deepEqual(Object.keys(config.env), ["development"]);
    const development = config.env.development;
    assert.equal(development.name, "forever-tee-print-executor-development");
    assert.deepEqual(development.migrations, [{ tag: "print-execution-v1", new_sqlite_classes: ["PrintAssetExecution"] }]);
    assert.deepEqual(development.durable_objects.bindings, [{ name: "PRINT_EXECUTIONS", class_name: "PrintAssetExecution" }]);
    assert.equal(development.d1_databases[0].database_id, protectedConfig("resource_fb377032d2f5"));
    assert.equal(development.r2_buckets[0].bucket_name, "forever-tee-design-artwork-development");
    assert.deepEqual(development.images, { binding: "IMAGES" });
});
test("primary API does not own the new print namespace lifecycle", async () => {
    const source = await readFile(new URL("../workers/api/src/index.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /export.*PrintAssetExecution/);
    // Inspect the whole configuration without depending on a JSONC parser.
    const apiConfig = await readFile(new URL("../workers/api/wrangler.jsonc", import.meta.url), "utf8");
    assert.doesNotMatch(apiConfig, /"new_sqlite_classes"\s*:\s*\[[^\]]*"PrintAssetExecution"/);
    assert.match(apiConfig, /"script_name"\s*:\s*"forever-tee-print-executor-development"/);
});
