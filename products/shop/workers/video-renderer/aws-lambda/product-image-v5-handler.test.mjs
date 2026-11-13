import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createProductImageV5Handler, validateProductImageV5Binding, validateProductImageV5Event } from "./product-image-v5-handler.mjs";
import { createProductImageV5Fixture, fixtureBinding, fixtureContext, fixtureEvent, fixtureFunctionArn, syntheticSources } from "../../../scripts/testing/product-image-v5-fixtures.mjs";

const assetDirectory = fileURLToPath(new URL("../../../apps/web/public/mockups/lifestyle-v4/", import.meta.url));
const binding = () => fixtureBinding("http://127.0.0.1:12345");
test("native binding accepts exact numbered versions and pins each configured identity", () => {
    assert.deepEqual(validateProductImageV5Binding(binding()), binding());
    for (const update of [
        { qualifiedFunctionArns: [fixtureFunctionArn] },
        { qualifiedFunctionArns: [`${fixtureFunctionArn}:$LATEST`] },
        { qualifiedFunctionArns: [`${fixtureFunctionArn}:live`] },
        { qualifiedFunctionArns: [`${fixtureFunctionArn}:0`] },
        { qualifiedFunctionArns: [`${fixtureFunctionArn}:07`] },
        { qualifiedFunctionArns: [`${fixtureFunctionArn}:7`, `${fixtureFunctionArn}:7`] },
        { qualifiedFunctionArns: [`${fixtureFunctionArn.replace("111111111111", "222222222222")}:7`] },
        { qualifiedFunctionArns: [`${fixtureFunctionArn.replace("ap-southeast-2", "us-east-1")}:7`] },
        { functionArn: `${fixtureFunctionArn}:7` },
        { buildId: "unknown" }, { extra: true }, { qualifiedFunctionArns: [] },
        { apiOrigin: "https://external.invalid" }, { apiOrigin: "http://localhost:12345" },
        { apiOrigin: "http://127.0.0.1:12345/path" }, { apiOrigin: "http://username:password@127.0.0.1:12345" },
        { environment: "work" }, { environment: "development" }, { environment: "production" },
    ]) assert.throws(() => validateProductImageV5Binding({ ...binding(), ...update }));
    for (const environment of ["development", "production"]) {
        const apiOrigin = environment === "production" ? "https://forever-tee-api.socialqueue.workers.dev" : "https://forever-tee-api-development.socialqueue.workers.dev";
        assert.equal(validateProductImageV5Binding({ ...binding(), environment, apiOrigin }).apiOrigin, apiOrigin);
    }
});
test("native events retain v5 grants and reject origin, recipe and legacy v4 overrides", () => {
    assert.equal(validateProductImageV5Event(fixtureEvent()).rendererVersion, "product-images-v5");
    for (const update of [
        { rendererVersion: "product-images-v4" }, { kind: "product-image" }, { schemaVersion: 2 },
        { apiOrigin: "https://external.invalid" }, { assetDirectory: "/tmp" }, { recipe: {} },
        { jobId: "-".repeat(36) }, { jobId: "https://external.invalid" },
        { grant: "" }, { grant: "invalid" }, { grant: "x".repeat(1025) },
    ]) assert.throws(() => validateProductImageV5Event({ ...fixtureEvent(), ...update }));
    for (const event of [undefined, null, [], "invalid"]) assert.throws(() => validateProductImageV5Event(event));
});
test("wrong context cannot transfer data; N/N-1 qualified versions use the same duplicate claim protocol", async () => {
    const source = (await syntheticSources()).png;
    const fixture = await createProductImageV5Fixture({ source, mode: "duplicate" });
    try {
        const execute = createProductImageV5Handler({ binding: fixtureBinding(fixture.origin), assetDirectory });
        for (const update of [
            { invokedFunctionArn: fixtureFunctionArn }, { invokedFunctionArn: `${fixtureFunctionArn}:9` },
            { invokedFunctionArn: `${fixtureFunctionArn}:live` }, { invokedFunctionArn: `${fixtureFunctionArn}:$LATEST` },
            { invokedFunctionArn: `${fixtureFunctionArn.replace("111111111111", "222222222222")}:7` },
            { awsRequestId: "" }, { getRemainingTimeInMillis: undefined },
            { getRemainingTimeInMillis: () => NaN }, { getRemainingTimeInMillis: () => 29999 },
        ]) await assert.rejects(execute(fixtureEvent(), { ...fixtureContext(), ...update }));
        assert.equal(fixture.calls.length, 0);
        for (const version of ["7", "8"]) assert.equal((await execute(fixtureEvent(), fixtureContext(version))).status, "skipped");
        assert.equal(fixture.calls.length, 2);
        assert.equal(fixture.publications.length, 0);
    }
    finally { await fixture.close(); }
});
test("a wrong signed grant is denied before source/publication and cannot change an owned execution", async () => {
    const source = (await syntheticSources()).png;
    const fixture = await createProductImageV5Fixture({ source });
    try {
        const execute = createProductImageV5Handler({ binding: fixtureBinding(fixture.origin), assetDirectory });
        await assert.rejects(execute({ ...fixtureEvent(), grant: "wrong.signature" }, fixtureContext()), /unavailable/);
        assert.equal(fixture.publications.length, 0);
        assert.equal(fixture.calls.length, 2); // Claim and the existing fenced failure callback.
        assert.ok(fixture.calls.every(call => call.executionId === fixture.calls[0].executionId));
        const completed = await execute(fixtureEvent(), fixtureContext());
        assert.equal(completed.key?.endsWith("white-flat.webp"), true);
        assert.equal((await execute(fixtureEvent(), fixtureContext())).status, "skipped");
        assert.equal(fixture.publications.length, 1);
    }
    finally { await fixture.close(); }
});

test("the actual native export fails closed without installation and keeps malformed binding values private", async () => {
    const saved = process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON;
    const { handler } = await import("./product-image-v5-entry.mjs");
    try {
        delete process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON;
        await assert.rejects(handler(fixtureEvent(), fixtureContext()), /Install the native v5/);
        process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON = "synthetic-sensitive-invalid-json";
        await assert.rejects(handler(fixtureEvent(), fixtureContext()), error => {
            assert.equal(error.message, "Invalid native v5 runtime binding.");
            assert.equal(error.message.includes("synthetic-sensitive"), false);
            return true;
        });
    }
    finally {
        if (saved === undefined) delete process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON;
        else process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON = saved;
    }
});
