import { protectedConfig } from "./protected-config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { projectEditorPlacement } from "@forever-tee/contracts";
import { attachRevisionToNullProducts, canonicalArtworkFingerprint, insertConfiguredProduct, } from "./design-revision-repository";
import { makeProductRepositoryLayer, ProductRepository } from "./product-repository";
const baseProductId = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const toteBaseProductId = "97b629d7-1d3b-4d2a-a586-537168141e97";
const readyDesignId = protectedConfig("resource_83abf907850d");
const pendingDesignId = protectedConfig("resource_08570b33aad6");
const secondDesignId = "62b597f7-42a2-450c-b090-61d8f278a4ca";
let platform: PlatformProxy<Env> | undefined;
interface RevisionSourceRow {
    artwork_key: string;
    byte_size: number;
    content_type: string;
    crop_x: number;
    crop_y: number;
    crop_zoom: number;
    depth: number;
    id: string;
    placement_width: number;
    placement_x: number;
    placement_y: number;
    sha256: string;
    updated_at: number;
}
function revisionSource(stored: RevisionSourceRow) {
    return {
        id: stored.id,
        artworkKey: stored.artwork_key,
        contentType: stored.content_type,
        byteSize: stored.byte_size,
        sha256: stored.sha256,
        cropX: stored.crop_x,
        cropY: stored.crop_y,
        cropZoom: stored.crop_zoom,
        placementX: stored.placement_x,
        placementY: stored.placement_y,
        placementWidth: stored.placement_width,
        depth: stored.depth,
        updatedAt: new Date(stored.updated_at),
    };
}
function testEnv() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform.env;
}
function productRepository() {
    return Effect.runPromise(Effect.gen(function* () {
        return yield* ProductRepository;
    }).pipe(Effect.provide(makeProductRepositoryLayer(testEnv()))));
}
async function seedDesign(id: string, options: {
    cropX?: number;
    pending?: boolean;
} = {}) {
    const pending = options.pending ?? false;
    const sha256 = pending ? "" : "a".repeat(64);
    await testEnv().DB.prepare(`
    INSERT INTO designs (
      id, owner_id, artwork_key, content_type, byte_size, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y,
      placement_width, depth, status, version, finalized_at,
      legacy_claim_expires_at, created_at, updated_at, deleted_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, 0.5, 1, 0.39, 0.43, 0.22, 5, ?,
      0, NULL, NULL, 1786831200000, 1786831260000, NULL)
  `).bind(id, pending ? `designs/${id}/pending` : `designs/${id}/artwork/${sha256}`, pending ? "application/octet-stream" : "image/png", pending ? 0 : 128, sha256, options.cropX ?? 0.5, pending ? "creating" : "ready").run();
}
async function seedProductFamily(designId: string) {
    const stored = await testEnv().DB.prepare("SELECT * FROM designs WHERE id = ?")
        .bind(designId).first<RevisionSourceRow>();
    if (!stored)
        throw new Error("Expected a design fixture.");
    const revisionId = stored.sha256 ? crypto.randomUUID() : null;
    if (revisionId) {
        await testEnv().DB.prepare(`
      INSERT INTO design_revisions (
        id, design_id, fingerprint, artwork_key, content_type, byte_size, sha256,
        crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at
      ) SELECT ?, id, ?, artwork_key, content_type, byte_size, sha256,
        crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, updated_at
        FROM designs WHERE id = ?
    `).bind(revisionId, revisionId, designId).run();
    }
    const repository = await productRepository();
    const family = [];
    for (const base of [baseProductId, toteBaseProductId]) {
        const id = crypto.randomUUID();
        await testEnv().DB.prepare(`
      INSERT INTO products (id, base_product_id, design_id, design_revision_id,
        shopify_handle, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', 1786831320000)
    `).bind(id, base, designId, revisionId, base === baseProductId ? "bent-shirt" : "cotton-tote").run();
        family.push(await Effect.runPromise(repository.find(id)));
    }
    return family;
}
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({
        configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
        persist: false,
        remoteBindings: false,
    });
    await testEnv().DB.prepare(`
    CREATE TABLE printify_catalogue_snapshots (
      id text PRIMARY KEY, base_product_id text NOT NULL, retrieved_at integer NOT NULL
    )
  `).run();
    await testEnv().DB.prepare(`
    CREATE TABLE printify_catalogue_variants (
      snapshot_id text NOT NULL, decoration_method text NOT NULL,
      print_width integer NOT NULL, print_height integer NOT NULL
    )
  `).run();
    await testEnv().DB.prepare(`
    CREATE TABLE shopify_variant_mapping_snapshots (
      id text PRIMARY KEY, catalogue_snapshot_id text NOT NULL,
      base_product_id text NOT NULL, shopify_product_handle text NOT NULL,
      retrieved_at integer NOT NULL
    )
  `).run();
    for (const [id, width, height] of [
        [baseProductId, 4682, 5291], [toteBaseProductId, 3600, 4200],
    ]) {
        await testEnv().DB.prepare("INSERT INTO printify_catalogue_snapshots VALUES (?, ?, 1)")
            .bind(id, id).run();
        await testEnv().DB.prepare("INSERT INTO printify_catalogue_variants VALUES (?, 'dtg', ?, ?)")
            .bind(id, width, height).run();
        await testEnv().DB.prepare("INSERT INTO shopify_variant_mapping_snapshots VALUES (?, ?, ?, ?, 1)")
            .bind(id, id, id, id === baseProductId ? "bent-shirt" : "cotton-tote").run();
    }
    await testEnv().DB.prepare(`
    CREATE TABLE designs (
      id text PRIMARY KEY NOT NULL, owner_id text, artwork_job_id text, artwork_key text NOT NULL UNIQUE,
      content_type text NOT NULL, byte_size integer NOT NULL, sha256 text NOT NULL,
      artwork_width integer, artwork_height integer,
      crop_x real NOT NULL, crop_y real NOT NULL, crop_zoom real NOT NULL,
      placement_x real NOT NULL, placement_y real NOT NULL,
      placement_width real NOT NULL, depth integer NOT NULL, status text NOT NULL,
      default_product_color text DEFAULT 'White' NOT NULL,
      default_product_color_model text,
      version integer DEFAULT 0 NOT NULL, finalized_at integer,
      legacy_claim_expires_at integer, created_at integer NOT NULL,
      updated_at integer NOT NULL, deleted_at integer
    )
  `).run();
    await testEnv().DB.prepare(`
    CREATE TABLE design_revisions (
      id text PRIMARY KEY NOT NULL, design_id text NOT NULL REFERENCES designs(id),
      fingerprint text NOT NULL, artwork_key text NOT NULL, content_type text NOT NULL,
      byte_size integer NOT NULL, artwork_width integer, artwork_height integer,
      sha256 text NOT NULL, crop_x real NOT NULL,
      crop_y real NOT NULL, crop_zoom real NOT NULL, placement_x real NOT NULL,
      placement_y real NOT NULL, placement_width real NOT NULL, depth integer NOT NULL,
      created_at integer NOT NULL
    )
  `).run();
    await testEnv().DB.prepare(`
    CREATE UNIQUE INDEX design_revisions_design_fingerprint_unique_idx
    ON design_revisions (design_id, fingerprint)
  `).run();
    await testEnv().DB.prepare(`
    CREATE TABLE products (
      print_mode text NOT NULL DEFAULT 'recursive', video_recursive_revision_id text, video_design_revision_id text,
      id text PRIMARY KEY NOT NULL, base_product_id text NOT NULL,
      design_id text REFERENCES designs(id),
      design_revision_id text REFERENCES design_revisions(id),
      placement_x real, placement_y real, placement_width real,
      placement_depth integer, projection_version text,
      default_color text DEFAULT 'White' NOT NULL,
      shopify_handle text NOT NULL, status text DEFAULT 'active' NOT NULL,
      created_at integer NOT NULL, deleted_at integer
    )
  `).run();
    await testEnv().DB.prepare(`
    CREATE UNIQUE INDEX products_active_design_revision_base_product_unique_idx
    ON products (design_revision_id, base_product_id)
    WHERE design_revision_id IS NOT NULL AND status = 'active'
  `).run();
    await testEnv().DB.prepare(`
    CREATE UNIQUE INDEX products_active_pending_design_base_product_unique_idx
    ON products (design_id, base_product_id)
    WHERE design_id IS NOT NULL AND design_revision_id IS NULL AND status = 'active'
  `).run();
});
beforeEach(async () => {
    await testEnv().DB.prepare("DROP TRIGGER IF EXISTS fail_configured_product_insert").run();
    await testEnv().DB.prepare("DELETE FROM products").run();
    await testEnv().DB.prepare("DELETE FROM design_revisions").run();
    await testEnv().DB.prepare("DELETE FROM designs").run();
    await testEnv().DB.prepare(`
    INSERT INTO products (
      id, base_product_id, design_id, design_revision_id,
      placement_x, placement_y, placement_width, placement_depth,
      shopify_handle, status, created_at, deleted_at
    ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'bent-shirt', 'active', 1786831200000, NULL)
  `).bind(baseProductId, baseProductId).run();
    await testEnv().DB.prepare(`
    INSERT INTO products (
      id, base_product_id, design_id, design_revision_id,
      placement_x, placement_y, placement_width, placement_depth,
      shopify_handle, status, created_at, deleted_at
    ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'cotton-tote', 'active', 1786831200000, NULL)
  `).bind(toteBaseProductId, toteBaseProductId).run();
});
afterAll(async () => {
    await platform?.dispose();
});
describe("ProductRepository", () => {
    it("rolls back the revision when the product link cannot be written", async () => {
        await seedDesign(readyDesignId);
        await testEnv().DB.prepare(`
      CREATE TRIGGER fail_configured_product_insert
      BEFORE INSERT ON products
      WHEN NEW.design_id IS NOT NULL
      BEGIN
        SELECT RAISE(FAIL, 'forced configured product failure');
      END
    `).run();
        const repository = await productRepository();
        const error = await Effect.runPromise(repository.createConfigured({
            baseProductId,
            designId: readyDesignId,
        }).pipe(Effect.flip));
        const count = await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM design_revisions").first<{
            count: number;
        }>();
        expect(error._tag).toBe("DatabaseFailure");
        expect(count?.count).toBe(0);
    });
    it("creates one immutable revision and returns it on retries", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const created = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        const retried = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        const count = await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM design_revisions").first<{
            count: number;
        }>();
        expect(created.designRevisionId).not.toBeNull();
        expect(retried).toEqual(created);
        expect(count?.count).toBe(1);
    });
    it("preserves one immutable link when product creation races attachment", async () => {
        await seedDesign(readyDesignId);
        const stored = await testEnv().DB.prepare("SELECT * FROM designs WHERE id = ?").bind(readyDesignId).first<RevisionSourceRow>();
        if (!stored)
            throw new Error("Expected the stored design fixture.");
        const source = revisionSource(stored);
        const configuredProductId = "47cba7a2-498e-44cc-9769-b37641e6a63a";
        await Promise.all([
            insertConfiguredProduct(testEnv().DB, source, {
                id: configuredProductId,
                baseProductId,
                defaultColor: "White",
                designId: readyDesignId,
                shopifyHandle: "bent-shirt",
                placement: { x: 0.39, y: 0.43, width: 0.22, depth: 5 },
                projectionVersion: "safe-margin-v1",
                createdAt: new Date(1786831320000),
            }),
            attachRevisionToNullProducts(testEnv().DB, source),
        ]);
        const linked = await testEnv().DB.prepare(`
      SELECT design_revision_id FROM products WHERE id = ?
    `).bind(configuredProductId).first<{
            design_revision_id: string | null;
        }>();
        const revisions = await testEnv().DB.prepare(`
      SELECT id, crop_x FROM design_revisions WHERE design_id = ?
    `).bind(readyDesignId).all<{
            crop_x: number;
            id: string;
        }>();
        expect(linked?.design_revision_id).toBe(revisions.results[0]?.id);
        expect(revisions.results).toHaveLength(1);
        await testEnv().DB.prepare("UPDATE designs SET crop_x = 0.9, updated_at = 1786831380000 WHERE id = ?").bind(readyDesignId).run();
        await attachRevisionToNullProducts(testEnv().DB, {
            ...source,
            cropX: 0.9,
            updatedAt: new Date(1786831380000),
        });
        const unchanged = await testEnv().DB.prepare(`
      SELECT products.design_revision_id, design_revisions.crop_x
      FROM products
      JOIN design_revisions ON design_revisions.id = products.design_revision_id
      WHERE products.id = ?
    `).bind(configuredProductId).first<{
            crop_x: number;
            design_revision_id: string;
        }>();
        const count = await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM design_revisions WHERE design_id = ?").bind(readyDesignId).first<{
            count: number;
        }>();
        expect(unchanged).toEqual({
            crop_x: 0.5,
            design_revision_id: linked?.design_revision_id,
        });
        expect(count?.count).toBe(1);
    });
    it("keeps the original revision after its mutable draft changes", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const created = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        await testEnv().DB.prepare("UPDATE designs SET crop_x = 0.75, updated_at = 1786831320000 WHERE id = ?").bind(readyDesignId).run();
        const retried = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        const revision = await testEnv().DB.prepare("SELECT crop_x FROM design_revisions WHERE id = ?").bind(created.designRevisionId).first<{
            crop_x: number;
        }>();
        expect(retried.designRevisionId).toBe(created.designRevisionId);
        expect(revision?.crop_x).toBe(0.5);
    });
    it("creates settings-distinct revisions and retains deleted provenance", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const first = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        await testEnv().DB.prepare("UPDATE products SET status = 'deleted', deleted_at = 1786831320000 WHERE id = ?").bind(first.id).run();
        await testEnv().DB.prepare("UPDATE designs SET crop_x = 0.75, updated_at = 1786831380000 WHERE id = ?").bind(readyDesignId).run();
        const second = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        const revisions = await testEnv().DB.prepare("SELECT fingerprint, crop_x FROM design_revisions ORDER BY created_at").all<{
            fingerprint: string;
            crop_x: number;
        }>();
        const deleted = await testEnv().DB.prepare("SELECT design_revision_id FROM products WHERE id = ?").bind(first.id).first<{
            design_revision_id: string | null;
        }>();
        const settings = async (cropX: number) => canonicalArtworkFingerprint(testEnv().DB, {
            cropX,
            cropY: 0.5,
            cropZoom: 1,
        });
        const firstSettings = await settings(0.5);
        const secondSettings = await settings(0.75);
        expect(second.designRevisionId).not.toBe(first.designRevisionId);
        expect(revisions.results).toEqual([
            { fingerprint: `revision-v2:${"a".repeat(64)}:${firstSettings}`, crop_x: 0.5 },
            { fingerprint: `revision-v2:${"a".repeat(64)}:${secondSettings}`, crop_x: 0.75 },
        ]);
        expect(deleted?.design_revision_id).toBe(first.designRevisionId);
    });
    it("leaves pending artwork null and attaches it once stored", async () => {
        await seedDesign(pendingDesignId, { pending: true });
        const repository = await productRepository();
        const pending = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: pendingDesignId }));
        expect(pending.designRevisionId).toBeNull();
        const sha256 = "b".repeat(64);
        await testEnv().DB.prepare(`
      UPDATE designs SET artwork_key = ?, content_type = 'image/png',
        byte_size = 256, sha256 = ?, status = 'ready', updated_at = 1786831440000
      WHERE id = ?
    `).bind(`designs/${pendingDesignId}/artwork/${sha256}`, sha256, pendingDesignId).run();
        const stored = await testEnv().DB.prepare("SELECT * FROM designs WHERE id = ?").bind(pendingDesignId).first<RevisionSourceRow>();
        if (!stored)
            throw new Error("Expected the stored design fixture.");
        await attachRevisionToNullProducts(testEnv().DB, revisionSource(stored));
        const linked = await Effect.runPromise(repository.find(pending.id));
        expect(linked.designRevisionId).not.toBeNull();
    });
    it("exposes a frozen preparation identity without letting legacy attachment snapshot the preview", async () => {
        await seedDesign(pendingDesignId, { pending: true });
        const repository = await productRepository();
        const product = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: pendingDesignId }));
        await testEnv().DB.prepare(`UPDATE designs SET status = 'processing', artwork_job_id = ?, finalized_at = 1,
      artwork_key = ?, sha256 = ? WHERE id = ?`).bind(crypto.randomUUID(), `designs/${pendingDesignId}/preview`, "a".repeat(64), pendingDesignId).run();
        const stored = await testEnv().DB.prepare("SELECT * FROM designs WHERE id = ?").bind(pendingDesignId).first<RevisionSourceRow>();
        if (!stored)
            throw new Error("Expected preview");
        await attachRevisionToNullProducts(testEnv().DB, revisionSource(stored));
        expect(await Effect.runPromise(repository.find(product.id))).toMatchObject({ designRevisionId: null, preparationId: pendingDesignId });
        expect(await Effect.runPromise(repository.findFamily(product.id))).toMatchObject([{ designRevisionId: null, preparationId: pendingDesignId }]);
        expect(await testEnv().DB.prepare("SELECT id FROM design_revisions WHERE design_id = ?").bind(pendingDesignId).first()).toBeNull();
    });
    it("returns the authoritative active immutable snapshot", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const product = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        if (!product.designRevisionId)
            throw new Error("Expected a linked revision.");
        const snapshot = await Effect.runPromise(repository.findActiveRevisionSnapshot(product.id));
        expect(snapshot).toEqual({
            configuredProductId: product.id,
            baseProductId,
            designId: readyDesignId,
            designRevisionId: product.designRevisionId,
            baseProductSlug: "staple-tee",
            placement: projectEditorPlacement({
                depth: 5,
                placementWidth: 0.22,
                placementX: 0.39,
                placementY: 0.43,
            }, "staple-tee"),
            projectionVersion: "safe-margin-v1",
            artworkSha256: "a".repeat(64),
            contentType: "image/png",
            byteSize: 128,
            shopifyHandle: "bent-shirt",
            artworkUrl: `/v2/internal/design-revisions/${product.designRevisionId}/artwork`,
        });
    });
    it("reuses a revision across base products and retains independent placement", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const shirt = await Effect.runPromise(repository.createConfigured({
            baseProductId,
            designId: readyDesignId,
        }));
        const tote = await Effect.runPromise(repository.createConfigured({
            baseProductId: toteBaseProductId,
            designId: readyDesignId,
        }));
        const retriedTote = await Effect.runPromise(repository.createConfigured({
            baseProductId: toteBaseProductId,
            designId: readyDesignId,
        }));
        expect(tote.designRevisionId).toBe(shirt.designRevisionId);
        expect(retriedTote).toEqual(tote);
        const shirtFamily = await Effect.runPromise(repository.findFamily(shirt.id));
        const toteFamily = await Effect.runPromise(repository.findFamily(tote.id));
        expect(shirtFamily.map((product) => product.id).sort()).toEqual([shirt.id, tote.id].sort());
        expect(toteFamily).toEqual(shirtFamily);
        const sourceSettings = {
            depth: 5,
            placementWidth: 0.22,
            placementX: 0.39,
            placementY: 0.43,
        };
        expect((await Effect.runPromise(repository.findActiveRevisionSnapshot(shirt.id))).placement)
            .toEqual(projectEditorPlacement(sourceSettings, "staple-tee"));
        expect((await Effect.runPromise(repository.findActiveRevisionSnapshot(tote.id))).placement)
            .toEqual(projectEditorPlacement(sourceSettings, "cotton-tote"));
        const revisionCompatibility = await testEnv().DB.prepare(`
      SELECT placement_x, placement_y, placement_width, depth
      FROM design_revisions WHERE id = ?
    `).bind(shirt.designRevisionId).first();
        expect(revisionCompatibility).toEqual({
            placement_x: 0,
            placement_y: 0,
            placement_width: 0.08,
            depth: 1,
        });
    });
    it("keeps product families on the anchor's immutable revision", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const original = await seedProductFamily(readyDesignId);
        await testEnv().DB.prepare("UPDATE designs SET sha256 = ? WHERE id = ?")
            .bind("b".repeat(64), readyDesignId).run();
        const revised = await seedProductFamily(readyDesignId);
        expect(revised[0]?.designRevisionId).not.toBe(original[0]?.designRevisionId);
        for (const family of [original, revised]) {
            for (const anchor of family) {
                const result = await Effect.runPromise(repository.findFamily(anchor.id));
                expect(result.map((product) => product.id).sort()).toEqual(family.map((product) => product.id).sort());
            }
        }
    });
    it("does not mix pending products with an already linked revision", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const original = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        await testEnv().DB.prepare("UPDATE designs SET status = 'creating', sha256 = '' WHERE id = ?")
            .bind(readyDesignId).run();
        const [pendingShirt, pendingTote] = await seedProductFamily(readyDesignId);
        if (!pendingShirt || !pendingTote)
            throw new Error("Expected pending products.");
        expect(pendingShirt.designRevisionId).toBeNull();
        expect(await Effect.runPromise(repository.findFamily(original.id))).toEqual([original]);
        const pendingFamily = await Effect.runPromise(repository.findFamily(pendingShirt.id));
        expect(pendingFamily.map((product) => product.id).sort()).toEqual([pendingShirt.id, pendingTote.id].sort());
        expect(await Effect.runPromise(repository.findFamily(baseProductId)))
            .toEqual([await Effect.runPromise(repository.find(baseProductId))]);
    });
    it.each([1, 2])("uses supplier geometry and crop zoom for legacy configuration, zoom=%s", async (zoom) => {
        await seedDesign(readyDesignId);
        await testEnv().DB.prepare(`
      UPDATE designs SET artwork_width = 2316, artwork_height = 3088, crop_zoom = ?
      WHERE id = ?
    `).bind(zoom, readyDesignId).run();
        const repository = await productRepository();
        const result = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }).pipe(Effect.either));
        expect(result._tag).toBe(zoom === 1 ? "Right" : "Left");
        if (result._tag === "Left")
            expect(result.left._tag).toBe("InvalidProductInput");
    });
    it("rejects only a projection whose artwork is below its resolution floor", async () => {
        await seedDesign(readyDesignId);
        await testEnv().DB.prepare(`
      UPDATE designs SET artwork_width = 2000, artwork_height = 2500
      WHERE id = ?
    `).bind(readyDesignId).run();
        const repository = await productRepository();
        const shirtError = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId })
            .pipe(Effect.flip));
        const tote = await Effect.runPromise(repository.createConfigured({
            baseProductId: toteBaseProductId,
            designId: readyDesignId,
        }));
        expect(shirtError._tag).toBe("InvalidProductInput");
        expect(tote.baseProductId).toBe(toteBaseProductId);
    });
    it("keeps a successful shirt projection when tote projection storage fails", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const shirt = await Effect.runPromise(repository.createConfigured({
            baseProductId,
            designId: readyDesignId,
        }));
        await testEnv().DB.prepare(`
      CREATE TRIGGER fail_tote_projection_insert
      BEFORE INSERT ON products
      WHEN NEW.design_id IS NOT NULL
        AND NEW.base_product_id = '${toteBaseProductId}'
      BEGIN
        SELECT RAISE(FAIL, 'forced tote projection failure');
      END
    `).run();
        const toteError = await Effect.runPromise(repository.createConfigured({
            baseProductId: toteBaseProductId,
            designId: readyDesignId,
        }).pipe(Effect.flip));
        const retained = await Effect.runPromise(repository.find(shirt.id));
        expect(toteError._tag).toBe("DatabaseFailure");
        expect(retained).toEqual(shirt);
        await testEnv().DB.prepare("DROP TRIGGER fail_tote_projection_insert").run();
    });
    it("serializes concurrent retries at each revision and base-product boundary", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const configured = await Promise.all([
            Effect.runPromise(repository.createConfigured({
                baseProductId,
                designId: readyDesignId,
            })),
            Effect.runPromise(repository.createConfigured({
                baseProductId,
                designId: readyDesignId,
            })),
            Effect.runPromise(repository.createConfigured({
                baseProductId: toteBaseProductId,
                designId: readyDesignId,
            })),
            Effect.runPromise(repository.createConfigured({
                baseProductId: toteBaseProductId,
                designId: readyDesignId,
            })),
        ]);
        const active = await testEnv().DB.prepare(`
      SELECT base_product_id, design_revision_id FROM products
      WHERE design_id = ? AND status = 'active' ORDER BY base_product_id
    `).bind(readyDesignId).all<{
            base_product_id: string;
            design_revision_id: string;
        }>();
        expect(active.results).toHaveLength(2);
        const [first, second] = active.results;
        if (!first || !second)
            throw new Error("Expected one active product per base product.");
        expect(first.design_revision_id).toBe(second.design_revision_id);
        expect(configured[0].id).toBe(configured[1].id);
        expect(configured[2].id).toBe(configured[3].id);
    });
    it("fails closed for null, mismatched, invalid, and inactive active snapshots", async () => {
        await seedDesign(readyDesignId);
        await seedDesign(secondDesignId, { cropX: 0.6 });
        const repository = await productRepository();
        const nullRevision = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        await testEnv().DB.prepare("UPDATE products SET design_revision_id = NULL WHERE id = ?").bind(nullRevision.id).run();
        expect((await Effect.runPromise(repository.findActiveRevisionSnapshot(nullRevision.id).pipe(Effect.flip)))._tag).toBe("ProductNotFound");
        if (!nullRevision.designRevisionId) {
            throw new Error("Expected a revision-linked product.");
        }
        await testEnv().DB.prepare("UPDATE products SET design_revision_id = ? WHERE id = ?").bind(nullRevision.designRevisionId, nullRevision.id).run();
        await testEnv().DB.prepare("UPDATE products SET design_id = NULL WHERE id = ?").bind(nullRevision.id).run();
        expect((await Effect.runPromise(repository.findActiveRevisionSnapshot(nullRevision.id).pipe(Effect.flip)))._tag).toBe("ProductNotFound");
        await testEnv().DB.prepare("UPDATE products SET design_id = ? WHERE id = ?").bind(readyDesignId, nullRevision.id).run();
        await testEnv().DB.prepare("UPDATE design_revisions SET design_id = ? WHERE id = ?").bind(secondDesignId, nullRevision.designRevisionId).run();
        expect((await Effect.runPromise(repository.findActiveRevisionSnapshot(nullRevision.id).pipe(Effect.flip)))._tag).toBe("ProductNotFound");
        await testEnv().DB.prepare("UPDATE design_revisions SET design_id = ?, sha256 = 'invalid' WHERE id = ?").bind(readyDesignId, nullRevision.designRevisionId).run();
        expect((await Effect.runPromise(repository.findActiveRevisionSnapshot(nullRevision.id).pipe(Effect.flip)))._tag).toBe("ProductNotFound");
        await testEnv().DB.prepare("UPDATE design_revisions SET sha256 = ? WHERE id = ?").bind("a".repeat(64), nullRevision.designRevisionId).run();
        await testEnv().DB.prepare("UPDATE products SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(Date.now(), nullRevision.id).run();
        expect((await Effect.runPromise(repository.findActiveRevisionSnapshot(nullRevision.id).pipe(Effect.flip)))._tag).toBe("ProductNotFound");
    });
    it("resolves a deleted product only through its exact historical revision", async () => {
        await seedDesign(readyDesignId);
        await seedDesign(secondDesignId, { cropX: 0.6 });
        const repository = await productRepository();
        const deleted = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        const other = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: secondDesignId }));
        if (!deleted.designRevisionId || !other.designRevisionId) {
            throw new Error("Expected revision-linked products.");
        }
        await testEnv().DB.prepare("UPDATE products SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(Date.now(), deleted.id).run();
        const historical = await Effect.runPromise(repository.findHistoricalRevisionSnapshot(deleted.id, deleted.designRevisionId));
        const wrongRevision = await Effect.runPromise(repository.findHistoricalRevisionSnapshot(deleted.id, other.designRevisionId).pipe(Effect.flip));
        expect(historical.configuredProductId).toBe(deleted.id);
        expect(historical.designRevisionId).toBe(deleted.designRevisionId);
        expect(wrongRevision._tag).toBe("ProductNotFound");
    });
    it("loads immutable artwork metadata from the revision ledger", async () => {
        await seedDesign(readyDesignId);
        const repository = await productRepository();
        const product = await Effect.runPromise(repository.createConfigured({ baseProductId, designId: readyDesignId }));
        if (!product.designRevisionId)
            throw new Error("Expected a linked revision.");
        const artwork = await Effect.runPromise(repository.findRevisionArtwork(product.designRevisionId));
        expect(artwork).toEqual({
            designRevisionId: product.designRevisionId,
            artworkKey: `designs/${readyDesignId}/artwork/${"a".repeat(64)}`,
            contentType: "image/png",
            byteSize: 128,
            sha256: "a".repeat(64),
        });
        await testEnv().DB.prepare("UPDATE design_revisions SET artwork_key = ? WHERE id = ?").bind(`designs/${readyDesignId}/artwork/mutable`, product.designRevisionId).run();
        const mutablePointer = await Effect.runPromise(repository.findRevisionArtwork(product.designRevisionId).pipe(Effect.flip));
        expect(mutablePointer._tag).toBe("ProductNotFound");
    });
});
