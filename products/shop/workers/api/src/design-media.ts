import { Effect } from "effect";
import { artworkPreviewKey, generateArtworkPreview, storeArtworkPreview } from "./artwork-preview";
import { ArtworkStorageFailure, DatabaseFailure, DesignNotFound } from "./design-errors";

interface MediaEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly IMAGES: ImagesBinding;
}

interface MediaRow {
  readonly artwork_key: string;
  readonly sha256: string;
  readonly content_type: string;
}

type MediaAccess = { readonly kind: "public" } | { readonly kind: "owner"; readonly ownerId: string };

// Publication authorizes the bytes referenced by an active product. Retained
// objects, ownership and finalization do not independently publish artwork.
function authorizedMedia(db: D1Database, id: string, access: MediaAccess) {
  const publication = `EXISTS (
    SELECT 1 FROM products p LEFT JOIN design_revisions r ON r.id = p.design_revision_id
    WHERE p.design_id = d.id AND p.status = 'active' AND p.deleted_at IS NULL AND (
      p.design_revision_id IS NULL OR (
        r.design_id = d.id AND r.artwork_key = d.artwork_key
        AND r.sha256 = d.sha256 AND r.content_type = d.content_type
      )
    )
  )`;
  return Effect.tryPromise({
    try: () => db.prepare(`SELECT d.artwork_key, d.sha256, d.content_type FROM designs d
      WHERE d.id = ? AND d.status = 'ready' AND d.deleted_at IS NULL
        AND ${access.kind === "public" ? publication : "d.owner_id = ?"}`)
      .bind(...(access.kind === "public" ? [id] : [id, access.ownerId])).first<MediaRow>(),
    catch: (cause) => new DatabaseFailure({ operation: "authorize design media", cause }),
  });
}

export function readDesignMedia(env: MediaEnv, id: string, access: MediaAccess, preview = false) {
  return Effect.gen(function*() {
    const row = yield* authorizedMedia(env.DB, id, access);
    if (!row?.sha256) return yield* Effect.fail(new DesignNotFound({ id }));
    const verify = () => authorizedMedia(env.DB, id, access).pipe(Effect.flatMap(current =>
      current?.artwork_key === row.artwork_key && current.sha256 === row.sha256 && current.content_type === row.content_type
        ? Effect.void : Effect.fail(new DesignNotFound({ id }))));
    const read = (key: string) => Effect.gen(function*() {
      yield* verify();
      const object = yield* Effect.tryPromise({
        try: () => env.DESIGN_ARTWORK.get(key),
        catch: (cause) => new ArtworkStorageFailure({ operation: "get design media", cause }),
      });
      yield* verify();
      if (!object) return undefined;
      const buffer = yield* Effect.tryPromise({
        try: () => object.arrayBuffer(),
        catch: (cause) => new ArtworkStorageFailure({ operation: "read design media", cause }),
      });
      yield* verify();
      return new Uint8Array(buffer);
    });
    if (preview) {
      const cached = yield* read(artworkPreviewKey(id, row.sha256));
      if (cached) return { bytes: cached, contentType: "image/webp" };
    }
    const original = yield* read(row.artwork_key);
    if (!original) return yield* Effect.fail(new DesignNotFound({ id }));
    if (!preview) return { bytes: original, contentType: row.content_type };
    yield* verify();
    const bytes = yield* generateArtworkPreview(env.IMAGES, original);
    yield* verify();
    yield* storeArtworkPreview(env.DESIGN_ARTWORK, id, row.sha256, bytes);
    yield* verify();
    return { bytes, contentType: "image/webp" };
  });
}
