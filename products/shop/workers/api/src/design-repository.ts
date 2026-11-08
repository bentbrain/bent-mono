import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Context, Effect, Layer, Schema } from "effect";

import {
  DesignId,
  type DesignDto,
  EditorSettingsSchema,
  type EditorSettingsDto,
} from "@forever-tee/contracts";
import { designs } from "./schema";
import {
  ArtworkStorageFailure,
  DatabaseFailure,
  DesignNotFound,
  InvalidDesignInput,
} from "./design-errors";
import { attachRevisionToNullProducts } from "./design-revision-repository";
import type { AllowedSafetyScreeningDecision } from "./openai-safety-screening";
import { readDesignMedia } from "./design-media";

export { artworkPreviewKey } from "./artwork-preview";

interface ArtworkRecord {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

interface DesignRepositoryEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly IMAGES: ImagesBinding;
}

const LEGACY_CLAIM_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

interface CreateDesignInput {
  readonly id: string;
  readonly artwork: Uint8Array;
  readonly contentType: string;
  readonly screening?: AllowedSafetyScreeningDecision;
  readonly settings?: EditorSettingsDto;
}

export interface DesignRepositoryShape {
  readonly create: () => Effect.Effect<DesignDto, DatabaseFailure>;
  readonly uploadArtwork: (
    input: CreateDesignInput,
  ) => Effect.Effect<DesignDto, InvalidDesignInput | DesignNotFound | DatabaseFailure | ArtworkStorageFailure>;
  readonly find: (
    id: string,
  ) => Effect.Effect<DesignDto, InvalidDesignInput | DesignNotFound | DatabaseFailure>;
  readonly artwork: (
    id: string,
  ) => Effect.Effect<ArtworkRecord, InvalidDesignInput | DesignNotFound | DatabaseFailure | ArtworkStorageFailure>;
  readonly artworkPreview: (
    id: string,
  ) => Effect.Effect<ArtworkRecord, InvalidDesignInput | DesignNotFound | DatabaseFailure | ArtworkStorageFailure>;
  readonly updateSettings: (
    id: string,
    settings: EditorSettingsDto,
  ) => Effect.Effect<DesignDto, InvalidDesignInput | DesignNotFound | DatabaseFailure>;
}

export const DesignRepository = Context.GenericTag<DesignRepositoryShape>(
  "ForeverTee/DesignRepository",
);

function parseId(id: string) {
  return Schema.decodeUnknown(DesignId)(id).pipe(
    Effect.mapError(() => new InvalidDesignInput({ message: "Invalid design id." })),
  );
}

function rowToDesign(row: typeof designs.$inferSelect): DesignDto {
  return {
    id: row.id,
    status: row.status === "ready" ? "ready" : "creating",
    contentType: row.contentType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    artworkRevision: /^[0-9a-f]{64}$/.test(row.sha256) ? row.sha256 : null,
    settings: {
      cropX: row.cropX,
      cropY: row.cropY,
      cropZoom: row.cropZoom,
      placementX: row.placementX,
      placementY: row.placementY,
      placementWidth: row.placementWidth,
      depth: row.depth,
    },
    artworkUrl: `/v1/designs/${row.id}/artwork`,
  };
}

export const makeDesignRepository = (
  env: DesignRepositoryEnv,
): DesignRepositoryShape => ({
  create: () =>
    Effect.gen(function*() {
      const db = drizzle(env.DB);
      const id = crypto.randomUUID();
      const now = new Date();
      const row: typeof designs.$inferSelect = {
        id,
        ownerId: null,
        artworkJobId: null,
        removeBackground: null,
        artworkKey: `designs/${id}/pending`,
        contentType: "application/octet-stream",
        byteSize: 0,
        artworkHeight: null,
        artworkWidth: null,
        sha256: "",
        cropX: 0.5,
        cropY: 0.5,
        cropZoom: 1,
        placementX: 0.39,
        placementY: 0.43,
        placementWidth: 0.22,
        depth: 5,
        status: "creating",
        safetyScreeningDecision: null,
        safetyScreeningModel: null,
        defaultProductColor: "White",
        defaultProductColorModel: null,
        defaultProductColorStatus: "fallback",
        version: 0,
        finalizedAt: null,
        legacyClaimExpiresAt: new Date(now.getTime() + LEGACY_CLAIM_WINDOW_MS),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      yield* Effect.tryPromise({
        try: () => db.insert(designs).values(row).run(),
        catch: (cause) => new DatabaseFailure({ operation: "insert design", cause }),
      });
      return rowToDesign(row);
    }),
  uploadArtwork: ({ id: rawId, artwork, contentType, screening, settings }) =>
    Effect.gen(function*() {
      const db = drizzle(env.DB);
      const id = yield* parseId(rawId);
      const current = yield* Effect.tryPromise({
        try: () => db.select().from(designs).where(eq(designs.id, id)).get(),
        catch: (cause) => new DatabaseFailure({ operation: "read design", cause }),
      });
      if (!current || current.status === "deleted" || current.ownerId !== null) {
        return yield* Effect.fail(new DesignNotFound({ id }));
      }
      const hashInput = new ArrayBuffer(artwork.byteLength);
      new Uint8Array(hashInput).set(artwork);
      const hash = yield* Effect.tryPromise({
        try: () => crypto.subtle.digest("SHA-256", hashInput),
        catch: (cause) => new ArtworkStorageFailure({ operation: "hash", cause }),
      });
      const sha256 = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      const artworkKey = `designs/${id}/artwork/${sha256}`;
      const existingArtwork = yield* Effect.tryPromise({
        try: () => env.DESIGN_ARTWORK.head(artworkKey),
        catch: (cause) => new ArtworkStorageFailure({ operation: "head", cause }),
      });
      if (!existingArtwork) {
        yield* Effect.tryPromise({
          try: () => env.DESIGN_ARTWORK.put(artworkKey, artwork, {
            httpMetadata: { contentType },
            customMetadata: { designId: id, sha256 },
            sha256: hash,
          }),
          catch: (cause) => new ArtworkStorageFailure({ operation: "put", cause }),
        });
      }

      const now = new Date();
      const artworkUpdate: Partial<typeof designs.$inferInsert> = {
        artworkKey,
        contentType: existingArtwork?.httpMetadata?.contentType ?? contentType,
        byteSize: existingArtwork?.size ?? artwork.byteLength,
        ...(screening
          ? {
              safetyScreeningDecision: screening.decision,
              safetyScreeningModel: screening.model,
            }
          : {}),
        sha256,
        status: "ready",
        updatedAt: now,
      };
      const update = Effect.tryPromise({
        try: async () => (await db.update(designs).set(
          settings
            ? {
                ...artworkUpdate,
                cropX: settings.cropX,
                cropY: settings.cropY,
                cropZoom: settings.cropZoom,
                placementX: settings.placementX,
                placementY: settings.placementY,
                placementWidth: settings.placementWidth,
                depth: settings.depth,
              }
            : artworkUpdate,
        ).where(and(eq(designs.id, id), isNull(designs.ownerId))).returning().all())[0],
        catch: (cause) => new DatabaseFailure({ operation: "update design artwork", cause }),
      });

      const updated = yield* update;
      if (!updated) return yield* Effect.fail(new DesignNotFound({ id }));

      yield* Effect.tryPromise({
        try: () => attachRevisionToNullProducts(env.DB, updated),
        catch: (cause) => new DatabaseFailure({
          operation: "attach design revision",
          cause,
        }),
      });

      // Source and preview objects are content-addressed and may already be
      // referenced by a future revision or order. Failed writes can leave a
      // safe orphan; deletion waits for reference-aware garbage collection.

      return rowToDesign(updated);
    }),
  find: (rawId) =>
    Effect.gen(function*() {
      const id = yield* parseId(rawId);
      const db = drizzle(env.DB);
      const row = yield* Effect.tryPromise({
        try: () => db.select().from(designs).where(eq(designs.id, id)).get(),
        catch: (cause) => new DatabaseFailure({ operation: "read design", cause }),
      });
      if (!row || row.status === "deleted") {
        return yield* Effect.fail(new DesignNotFound({ id }));
      }
      yield* Schema.decodeUnknown(EditorSettingsSchema)({
        cropX: row.cropX,
        cropY: row.cropY,
        cropZoom: row.cropZoom,
        placementX: row.placementX,
        placementY: row.placementY,
        placementWidth: row.placementWidth,
        depth: row.depth,
      }).pipe(
        Effect.mapError((cause) => new DatabaseFailure({ operation: "decode design", cause })),
      );
      return rowToDesign(row);
    }),
  artwork: (rawId) => parseId(rawId).pipe(
    Effect.flatMap(id => readDesignMedia(env, id, { kind: "public" })),
  ),
  artworkPreview: (rawId) => parseId(rawId).pipe(
    Effect.flatMap(id => readDesignMedia(env, id, { kind: "public" }, true)),
  ),
  updateSettings: (rawId, settings) =>
    Effect.gen(function*() {
      const id = yield* parseId(rawId);
      const db = drizzle(env.DB);
      const result = yield* Effect.tryPromise({
        try: async () => (await db.update(designs).set({
          cropX: settings.cropX,
          cropY: settings.cropY,
          cropZoom: settings.cropZoom,
          placementX: settings.placementX,
          placementY: settings.placementY,
          placementWidth: settings.placementWidth,
          depth: settings.depth,
          updatedAt: new Date(),
        }).where(and(eq(designs.id, id), isNull(designs.ownerId))).returning().all())[0],
        catch: (cause) => new DatabaseFailure({ operation: "update design", cause }),
      });
      if (!result) return yield* Effect.fail(new DesignNotFound({ id }));
      yield* Effect.tryPromise({
        try: () => attachRevisionToNullProducts(env.DB, result),
        catch: (cause) => new DatabaseFailure({
          operation: "attach design revision",
          cause,
        }),
      });
      return rowToDesign(result);
    }),
});

export const makeDesignRepositoryLayer = (env: DesignRepositoryEnv) =>
  Layer.succeed(DesignRepository, makeDesignRepository(env));
