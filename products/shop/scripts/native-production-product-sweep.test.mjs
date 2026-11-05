import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProductColor, backfillProductColors, configureMissingFamilies, createLegacyProducts, createMissingVideoJobs, normalizeIncompatibleVideoJobIds, validateAudit, waitForCompleteProducts, } from "./native-production-product-sweep.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const owner = "a".repeat(64);
test("the product sweep requires complete colours, two products per family and two ready videos per product", () => {
    const complete = validateAudit({ ready_designs: 4, complete_colors: 4, finalized_designs: 3, active_products: 6,
        default_mismatches: 0, complete_families: 3, video_jobs: 12, ready_videos: 12, terminal_videos: 0 });
    assert.equal(complete.complete, true);
    assert.equal(complete.expectedVideos, 12);
    for (const change of [{ complete_colors: 3 }, { active_products: 5 }, { complete_families: 2 }, { video_jobs: 11 },
        { ready_videos: 11 }, { default_mismatches: 1 }, { terminal_videos: 1 }]) {
        assert.equal(validateAudit({ ...complete, ...change }).complete, false);
    }
});
test("colour analysis sends a low-detail bounded preview and accepts only the strict decision", async () => {
    let body;
    const decision = await analyzeProductColor(Buffer.from("jpeg"), owner, "secret", async (_url, init) => {
        body = JSON.parse(init.body);
        return Response.json({ status: "completed", model: "gpt-5.6-luna-2026-09-01",
            output: [{ type: "message", content: [{ type: "output_text", text: '{"color":"Black"}' }] }] });
    });
    assert.deepEqual(decision, { color: "Black", model: "gpt-5.6-luna-2026-09-01" });
    assert.equal(body.input[0].content[1].detail, "low");
    assert.equal(body.store, false);
    await assert.rejects(analyzeProductColor(Buffer.from("jpeg"), owner, "secret", async () => Response.json({ status: "completed", model: "gpt-5.6-luna", output: [] })), /invalid decision/);
});
test("colour backfill verifies immutable artwork before guarded persistence", async () => {
    const artwork = Buffer.from("artwork"), digest = (await import("node:crypto")).createHash("sha256").update(artwork).digest("hex");
    const queries = [];
    const cf = { productSweepArtwork: async () => new Response(artwork), query: async (sql, params) => {
            queries.push({ sql, params });
            return [{ meta: { changes: 1 } }];
        } };
    const changed = await backfillProductColors(cf, [{ id, owner_id: owner, artwork_key: `designs/${id}/artwork/${digest}`,
            byte_size: artwork.length, sha256: digest }], { OPENAI_API_KEY: "secret" }, {
        preparePreview: async () => Buffer.from("preview"), analyze: async () => ({ color: "White", model: "model-v1" }),
    });
    assert.equal(changed, 1);
    assert.deepEqual(queries[0].params, ["White", "model-v1", id, `designs/${id}/artwork/${digest}`, digest]);
    await assert.rejects(backfillProductColors({ ...cf, productSweepArtwork: async () => new Response("changed") }, [{ id, owner_id: owner, artwork_key: `designs/${id}/artwork/${digest}`, byte_size: artwork.length, sha256: digest }], { OPENAI_API_KEY: "secret" }, { preparePreview: async () => Buffer.from("preview"), analyze: async () => ({ color: "White", model: "model-v1" }) }), /does not match/);
});
test("colour backfill accepts a retained Production canary only through its exact ledger key", async () => {
    const artwork = Buffer.from("canary"), digest = (await import("node:crypto")).createHash("sha256").update(artwork).digest("hex");
    const row = { id, owner_id: owner, artwork_key: `designs/${id}/native-production-canary.png`, byte_size: artwork.length, sha256: digest };
    assert.equal(await backfillProductColors({ productSweepArtwork: async () => new Response(artwork),
        query: async () => [{ meta: { changes: 1 } }] }, [row], { OPENAI_API_KEY: "secret" }, {
        preparePreview: async () => Buffer.from("preview"), analyze: async () => ({ color: "White", model: "model-v1" }),
    }), 1);
    await assert.rejects(backfillProductColors({ productSweepArtwork: async () => new Response(artwork), query: async () => [{ meta: { changes: 1 } }] }, [{ ...row, artwork_key: `designs/${id}/other.png` }], { OPENAI_API_KEY: "secret" }, {
        preparePreview: async () => Buffer.from("preview"), analyze: async () => ({ color: "White", model: "model-v1" }),
    }), /invalid colour-backfill/);
});
test("family replay uses the existing owner-scoped API and requires both catalogue products", async () => {
    let observed;
    const count = await configureMissingFamilies([{ id, owner_id: owner, version: 7 }], {
        WORKER_URL: "https://worker.example", FOREVER_TEE_API_SHARED_SECRET: "s".repeat(32),
    }, async (url, init) => {
        observed = { url, body: JSON.parse(init.body), headers: init.headers };
        return Response.json({ products: [
                { baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c", defaultColor: "Black", designId: id },
                { baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97", defaultColor: "Black", designId: id },
            ] }, { status: 201 });
    });
    assert.equal(count, 1);
    assert.equal(observed.url, "https://worker.example/v2/configured-product-families");
    assert.equal(observed.body.expectedVersion, 7);
    assert.equal(observed.headers["x-forever-tee-owner-id"], owner);
});
test("legacy families get only the missing tote with the current projected placement", async () => {
    const queries = [];
    const productId = "22222222-2222-4222-8222-222222222222";
    const result = await createLegacyProducts({ query: async (sql, params) => {
            queries.push({ sql, params });
            return [{ meta: { changes: 1 } }];
        } }, [{ id, placement_x: 0.39, placement_y: 0.43, placement_width: 0.22, depth: 5 }], { now: () => 123, uuid: () => productId });
    assert.deepEqual(result, [productId]);
    assert.equal(queries[0].params[0], productId);
    assert.deepEqual(queries[0].params.slice(2, 6), [0.399157, 0.435827, 0.201686, 5]);
});
test("missing video jobs use the exact current immutable keys and product colours", async () => {
    const queries = [];
    const inserted = await createMissingVideoJobs({ query: async (sql, params) => {
            queries.push({ sql, params });
            return [{ meta: { changes: 1 } }];
        } }, [{ id, design_revision_id: "33333333-3333-4333-8333-333333333333", base_product_id: "97b629d7-1d3b-4d2a-a586-537168141e97", colours: "black" }], { now: () => 123, uuid: () => "44444444-4444-4444-8444-444444444444" });
    assert.equal(inserted, 1);
    assert.equal(queries[0].params[1], "Cream");
    assert.equal(queries[0].params[3], `story-videos/v7/33333333-3333-4333-8333-333333333333/${id}/cream.mp4`);
});
test("incompatible migrated v7 job identities are replaced without changing product media identity", async () => {
    const queries = [];
    const replacement = "44444444-4444-4444-8444-444444444444";
    const changed = await normalizeIncompatibleVideoJobIds({ query: async (sql, params) => {
            queries.push({ sql, params });
            return [{ meta: { changes: 1 } }];
        } }, [{ id: `${id}-v7` }], { now: () => 123, uuid: () => replacement });
    assert.equal(changed, 1);
    assert.deepEqual(queries[0].params, [replacement, 123, `${id}-v7`, "story-video-renderer-v7"]);
    assert.match(queries[0].sql, /last_error='Invalid render grant\.'/);
    await assert.rejects(normalizeIncompatibleVideoJobIds({ query: async () => [{ meta: { changes: 1 } }] }, [{ id: `${id}-v5-v6-v7` }], { uuid: () => replacement }), /invalid incompatible/);
});
test("completion wait stops on terminal video failures and succeeds after the cohort is ready", async () => {
    const complete = { ready_designs: 2, complete_colors: 2, finalized_designs: 2, active_products: 4, default_mismatches: 0,
        complete_families: 2, video_jobs: 8, ready_videos: 8, terminal_videos: 0 };
    const values = [{ ...complete, ready_videos: 4 }, complete];
    const cf = { query: async () => [{ results: [values.shift()] }] };
    assert.equal((await waitForCompleteProducts(cf, { intervalMs: 0, sleep: async () => undefined })).complete, true);
    await assert.rejects(waitForCompleteProducts({ query: async () => [{ results: [{ ...complete, ready_videos: 4, terminal_videos: 1 }] }] }, { intervalMs: 0, sleep: async () => undefined }), /exhausted/);
});
