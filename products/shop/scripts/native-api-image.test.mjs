import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { apiOnlyPaths, prepareApiImage } from "./native-api-image.mjs";
function fixture(environment = "development") {
    const candidate = { imageDigest: `sha256:${"a".repeat(64)}`, sourceDigest: "b".repeat(64) };
    const runtime = { runtimeVerified: true, renderer: { ...candidate, revisionId: "renderer-1" },
        failure: { imageDigest: candidate.imageDigest, revisionId: "failure-1" } };
    const previous = { environment, accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", releaseId: "native-111",
        sourceCommit: "a".repeat(40), candidate };
    const verified = { releaseId: previous.releaseId, sourceCommit: previous.sourceCommit, runtime };
    const control = { paused: 0, release_id: null, current_release_id: "native-111", paused_at: 1 };
    let probes = 0;
    const cf = { query: async (sql, params) => [{ results: sql.includes("native_video_release_control") ? [{ ...control }] :
                    sql.startsWith("SELECT COUNT") ? [{ count: 0 }] :
                        [{ payload: JSON.stringify(params[1] === "prepared" ? { ...previous, preparation: { key: "proof" } } : verified) }] }] };
    const input = { environment, sha: "b".repeat(40), cf, candidate, runtime, inspectRuntime: async () => structuredClone(runtime),
        store: { read: async () => Buffer.from(JSON.stringify(previous)), save: async (_name, bytes) => ({ bytes }) },
        changes: () => ["workers/api/src/cart-line-capabilities.ts"], probeRuntime: async () => { probes++; return { verified: true }; } };
    return { input, control, previous, verified, probes: () => probes };
}
test("API lane retains immutable preparation, pause and startup verification with zero image writes", async () => {
    for (const environment of ["development", "production"]) {
        const f = fixture(environment), image = await prepareApiImage(f.input);
        const saved = await image.preserve();
        assert.equal(JSON.parse(saved.bytes).fullCloudQualificationRequired, true);
        assert.equal(image.review.updateCount, 0);
        f.control.paused = 1;
        f.control.release_id = "native-222";
        const result = await image.apply(f.input.cf, "native-222");
        assert.equal(result.applied, false);
        assert.equal(result.startupVerified, true);
        assert.equal(f.probes(), 1);
        await assert.rejects(image.apply(f.input.cf, "native-222"), /already attempted/);
    }
});
test("unknown source, dependencies, migrations, renderer and infrastructure force full lane", () => {
    for (const paths of [undefined, ["workers/api/drizzle/0030_test.sql"], ["bun.lock"], ["workers/api/package.json"],
        ["apps/web/public/mockups/tee.png"], ["workers/video-renderer/src/worker.ts"], ["infra/story-video-production/runtime.tf"], ["scripts/anything.mjs"]]) {
        assert.equal(apiOnlyPaths(paths), false);
    }
    assert.equal(apiOnlyPaths(["workers/api/src/index.ts", "apps/web/src/app/page.tsx", "docs/change.md"]), true);
});
test("missing or changed predecessor, mixed images and an existing pause stop before release", async () => {
    for (const mutate of [f => { f.control.paused = 1; }, f => { f.previous.sourceCommit = "main"; },
        f => { f.input.runtime.failure.imageDigest = "different"; }, f => { f.verified.runtime = {}; },
        f => { f.input.store.read = async () => Buffer.from("{}"); }, f => { f.input.changes = () => undefined; }]) {
        const f = fixture();
        mutate(f);
        await assert.rejects(prepareApiImage(f.input));
        assert.equal(f.probes(), 0);
    }
});
test("runtime drift or lost pause ownership prevents API cutover", async () => {
    const f = fixture(), image = await prepareApiImage(f.input);
    await assert.rejects(image.apply(f.input.cf, "native-222"), /pause ownership/);
    const h = fixture();
    let current = h.input.runtime;
    h.input.inspectRuntime = async () => current;
    const checked = await prepareApiImage(h.input);
    h.control.paused = 1;
    h.control.release_id = "native-222";
    current = { ...current, renderer: { ...current.renderer, revisionId: "new" } };
    await assert.rejects(checked.apply(h.input.cf, "native-222"), /runtime drift/);
});
test("mutating a caller-owned runtime snapshot cannot conceal remote drift", async () => {
    const f = fixture(), image = await prepareApiImage(f.input);
    f.input.runtime.renderer.revisionId = "changed";
    f.control.paused = 1;
    f.control.release_id = "native-222";
    await assert.rejects(image.apply(f.input.cf, "native-222"), /runtime drift/);
});
test("an active render after the drain stops before startup and Worker cutover", async () => {
    const f = fixture(), image = await prepareApiImage(f.input), query = f.input.cf.query;
    f.control.paused = 1;
    f.control.release_id = "native-222";
    f.input.cf.query = (sql, params) => sql.startsWith("SELECT COUNT") ? [{ results: [{ count: 1 }] }] : query(sql, params);
    await assert.rejects(image.apply(f.input.cf, "native-222"), /active render remains/);
    assert.equal(f.probes(), 0);
});
test('quiet drain proof is derived from unchanged render inputs, never just an API mode flag', async () => {
    const f = fixture();
    f.input.changes = () => ['workers/api/src/printify-order-identity.ts'];
    f.input.manifest = () => ({ schemaVersion: 1, boundary: 'isolated-printify-contracts-v2', inputsDigest: 'd'.repeat(64) });
    assert.equal((await prepareApiImage(f.input)).review.drainPolicy, 'unchanged-render-handlers-v1');
    for (const delta of [
        { changes: () => ['workers/api/src/index.ts'] },
        { changes: () => ['workers/api/src/printify-webhooks.ts'] },
        { manifest: () => null },
        { manifest: sha => ({ schemaVersion: 1, boundary: 'isolated-printify-contracts-v2', inputsDigest: (sha[0] === 'a' ? 'a' : 'b').repeat(64) }) },
    ])
        assert.equal((await prepareApiImage({ ...f.input, ...delta })).review.drainPolicy, undefined);
});
