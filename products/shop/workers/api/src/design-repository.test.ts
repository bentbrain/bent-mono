import { protectedConfig } from "./protected-config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { artworkPreviewKey, makeDesignRepository } from "./design-repository";
const DESIGN_ID = protectedConfig("resource_83abf907850d");
const PRODUCT_ID = "7fc75bac-93d7-4f01-8744-e9ec46160a62";
const CREATE_DESIGNS_TABLE = `
  CREATE TABLE designs (
    id text PRIMARY KEY NOT NULL,
    owner_id text, artwork_job_id text,
    artwork_key text NOT NULL UNIQUE,
    content_type text NOT NULL,
    byte_size integer NOT NULL,
    artwork_width integer,
    artwork_height integer,
    sha256 text NOT NULL,
    crop_x real NOT NULL,
    crop_y real NOT NULL,
    crop_zoom real NOT NULL,
    placement_x real NOT NULL,
    placement_y real NOT NULL,
    placement_width real NOT NULL,
    depth integer NOT NULL,
    status text NOT NULL,
    safety_screening_decision text,
    safety_screening_model text,
    default_product_color text DEFAULT 'White' NOT NULL,
    default_product_color_model text,
    version integer DEFAULT 0 NOT NULL,
    finalized_at integer,
    legacy_claim_expires_at integer,
    created_at integer NOT NULL,
    updated_at integer NOT NULL,
    deleted_at integer
  );
`;
const CREATE_REVISIONS_TABLE = `
  CREATE TABLE design_revisions (
    id text PRIMARY KEY NOT NULL,
    design_id text NOT NULL REFERENCES designs(id),
    fingerprint text NOT NULL,
    artwork_key text NOT NULL,
    content_type text NOT NULL,
    byte_size integer NOT NULL,
    artwork_width integer,
    artwork_height integer,
    sha256 text NOT NULL,
    crop_x real NOT NULL,
    crop_y real NOT NULL,
    crop_zoom real NOT NULL,
    placement_x real NOT NULL,
    placement_y real NOT NULL,
    placement_width real NOT NULL,
    depth integer NOT NULL,
    created_at integer NOT NULL,
    UNIQUE (design_id, fingerprint)
  );
`;
const CREATE_PRODUCTS_TABLE = `
  CREATE TABLE products (
      print_mode text NOT NULL DEFAULT 'recursive', video_recursive_revision_id text, video_design_revision_id text,
    id text PRIMARY KEY NOT NULL,
    design_id text REFERENCES designs(id),
    design_revision_id text REFERENCES design_revisions(id)
  );
`;
let platform: PlatformProxy<Env> | undefined;
function testEnv() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform.env;
}
async function sha256(bytes: Uint8Array) {
    const input = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(input).set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", input);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function seedDesign(sha: string) {
    const env = testEnv();
    const artworkKey = `designs/${DESIGN_ID}/artwork/${sha}`;
    await env.DB.prepare(`
    INSERT INTO designs (
      id, owner_id, artwork_key, content_type, byte_size, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y,
      placement_width, depth, status, created_at, updated_at, deleted_at
    ) VALUES (?, NULL, ?, 'image/png', 3, ?, 0.5, 0.5, 1, 0.39, 0.43,
      0.22, 5, 'ready', 1786579200000, 1786579200000, NULL)
  `).bind(DESIGN_ID, artworkKey, sha).run();
    return artworkKey;
}
async function seedNullRevisionProduct() {
    await testEnv().DB.prepare(`
    INSERT INTO products (id, design_id, design_revision_id)
    VALUES (?, ?, NULL)
  `).bind(PRODUCT_ID, DESIGN_ID).run();
}
async function productRevision() {
    return testEnv().DB.prepare(`
    SELECT
      products.design_revision_id,
      design_revisions.sha256,
      design_revisions.crop_x
    FROM products
    LEFT JOIN design_revisions
      ON design_revisions.id = products.design_revision_id
    WHERE products.id = ?
  `).bind(PRODUCT_ID).first<{
        crop_x: number | null;
        design_revision_id: string | null;
        sha256: string | null;
    }>();
}
async function failArtworkUpdates() {
    await testEnv().DB.prepare(`
    CREATE TRIGGER fail_artwork_update
    BEFORE UPDATE OF artwork_key ON designs
    BEGIN
      SELECT RAISE(FAIL, 'forced artwork update failure');
    END;
  `).run();
}
async function currentArtworkKey() {
    const row = await testEnv().DB.prepare("SELECT artwork_key FROM designs WHERE id = ?").bind(DESIGN_ID).first<{
        artwork_key: string;
    }>();
    return row?.artwork_key;
}
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({
        configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
        persist: false,
        remoteBindings: false,
    });
    await testEnv().DB.prepare(CREATE_DESIGNS_TABLE).run();
    await testEnv().DB.prepare(CREATE_REVISIONS_TABLE).run();
    await testEnv().DB.prepare(CREATE_PRODUCTS_TABLE).run();
});
beforeEach(async () => {
    const env = testEnv();
    await env.DB.prepare("DROP TRIGGER IF EXISTS fail_artwork_update").run();
    await env.DB.prepare("DELETE FROM products").run();
    await env.DB.prepare("DELETE FROM design_revisions").run();
    await env.DB.prepare("DELETE FROM designs").run();
    const stored = await env.DESIGN_ARTWORK.list();
    if (stored.objects.length > 0) {
        await env.DESIGN_ARTWORK.delete(stored.objects.map(({ key }) => key));
    }
});
afterAll(async () => {
    await platform?.dispose();
});
describe("design artwork replacement storage", () => {
    it("exposes the artwork content hash as its stable cache revision", async () => {
        const revision = "a".repeat(64);
        await seedDesign(revision);
        const design = await Effect.runPromise(makeDesignRepository(testEnv()).find(DESIGN_ID));
        expect(design.artworkRevision).toBe(revision);
    });
    it("retains the prior source and preview after a successful replacement", async () => {
        const env = testEnv();
        const previousSha = "previous-hash";
        const previousSourceKey = await seedDesign(previousSha);
        const previousPreviewKey = artworkPreviewKey(DESIGN_ID, previousSha);
        await env.DESIGN_ARTWORK.put(previousSourceKey, new Uint8Array([1, 2, 3]));
        await env.DESIGN_ARTWORK.put(previousPreviewKey, new Uint8Array([4, 5, 6]));
        const replacement = new Uint8Array([7, 8, 9]);
        const replacementKey = `designs/${DESIGN_ID}/artwork/${await sha256(replacement)}`;
        await Effect.runPromise(makeDesignRepository(env).uploadArtwork({
            id: DESIGN_ID,
            artwork: replacement,
            contentType: "image/png",
        }));
        expect(await env.DESIGN_ARTWORK.head(previousSourceKey)).not.toBeNull();
        expect(await env.DESIGN_ARTWORK.head(previousPreviewKey)).not.toBeNull();
        const replacementObject = await env.DESIGN_ARTWORK.head(replacementKey);
        expect(replacementObject).not.toBeNull();
        expect(replacementObject?.checksums.sha256
            ? Array.from(new Uint8Array(replacementObject.checksums.sha256), (byte) => byte.toString(16).padStart(2, "0")).join("")
            : undefined).toBe(await sha256(replacement));
        expect(await currentArtworkKey()).toBe(replacementKey);
    });
    it("attaches an existing null Product when artwork storage completes", async () => {
        const env = testEnv();
        await seedDesign("previous-hash");
        await seedNullRevisionProduct();
        const replacement = new Uint8Array([21, 22, 23]);
        const replacementSha = await sha256(replacement);
        await Effect.runPromise(makeDesignRepository(env).uploadArtwork({
            id: DESIGN_ID,
            artwork: replacement,
            contentType: "image/png",
        }));
        const revision = await productRevision();
        expect(typeof revision?.design_revision_id).toBe("string");
        expect(revision?.crop_x).toBe(0.5);
        expect(revision?.sha256).toBe(replacementSha);
    });
    it("attaches an existing null Product after settings change", async () => {
        const env = testEnv();
        await seedDesign("stored-hash");
        await seedNullRevisionProduct();
        await Effect.runPromise(makeDesignRepository(env).updateSettings(DESIGN_ID, {
            cropX: 0.75,
            cropY: 0.5,
            cropZoom: 1,
            placementX: 0.39,
            placementY: 0.43,
            placementWidth: 0.22,
            depth: 5,
        }));
        const revision = await productRevision();
        expect(typeof revision?.design_revision_id).toBe("string");
        expect(revision?.crop_x).toBe(0.75);
        expect(revision?.sha256).toBe("stored-hash");
    });
    it("does not overwrite or delete an existing same-hash object when D1 fails", async () => {
        const env = testEnv();
        const artwork = new Uint8Array([10, 11, 12]);
        const artworkSha = await sha256(artwork);
        const artworkKey = await seedDesign(artworkSha);
        await env.DESIGN_ARTWORK.put(artworkKey, artwork, {
            httpMetadata: { contentType: "image/png" },
            customMetadata: { retained: "true" },
        });
        const before = await env.DESIGN_ARTWORK.head(artworkKey);
        await failArtworkUpdates();
        const error = await Effect.runPromise(makeDesignRepository(env).uploadArtwork({
            id: DESIGN_ID,
            artwork,
            contentType: "image/jpeg",
        }).pipe(Effect.flip));
        const after = await env.DESIGN_ARTWORK.head(artworkKey);
        expect(error._tag).toBe("DatabaseFailure");
        expect(after?.version).toBe(before?.version);
        expect(after?.customMetadata?.["retained"]).toBe("true");
        expect(after?.httpMetadata?.contentType).toBe("image/png");
        expect(await currentArtworkKey()).toBe(artworkKey);
    });
    it("retains a newly stored content-addressed object when D1 fails", async () => {
        const env = testEnv();
        const previousKey = await seedDesign("previous-hash");
        await env.DESIGN_ARTWORK.put(previousKey, new Uint8Array([1, 2, 3]));
        const replacement = new Uint8Array([13, 14, 15]);
        const replacementKey = `designs/${DESIGN_ID}/artwork/${await sha256(replacement)}`;
        await failArtworkUpdates();
        const error = await Effect.runPromise(makeDesignRepository(env).uploadArtwork({
            id: DESIGN_ID,
            artwork: replacement,
            contentType: "image/png",
        }).pipe(Effect.flip));
        expect(error._tag).toBe("DatabaseFailure");
        expect(await env.DESIGN_ARTWORK.head(previousKey)).not.toBeNull();
        expect(await env.DESIGN_ARTWORK.head(replacementKey)).not.toBeNull();
        expect(await currentArtworkKey()).toBe(previousKey);
    });
});
