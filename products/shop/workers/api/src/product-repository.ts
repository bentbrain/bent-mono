import { pendingProductPreparation } from "./pending-product-families";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Context, Effect, Layer, Option, Schema } from "effect";

import {
  ConfiguredProductRevisionSnapshotSchema,
  DesignRevisionId,
  ProductId,
  baseProductSlugForId,
  projectEditorPlacement,
  type ConfiguredProductRevisionSnapshotDto,
  type ProductDto,
} from "@forever-tee/contracts";
import { MAX_DESIGN_ARTWORK_BYTES } from "@forever-tee/contracts/limits";
import { DatabaseFailure } from "./design-errors";
import {
  insertConfiguredProduct,
  type ConfiguredProductRecord,
} from "./design-revision-repository";
import { InvalidProductInput, ProductNotFound } from "./product-errors";
import { designs, products } from "./schema";
import { productPrintResolution } from "./print-assets";

const SAFE_PRODUCT_PROJECTION_VERSION = "safe-margin-v1";

interface CreateConfiguredProductInput {
  readonly baseProductId: string;
  readonly designId: string;
}

interface ProductRepositoryEnv {
  readonly DB: D1Database;
}

interface RevisionArtworkRecord {
  readonly artworkKey: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly designRevisionId: string;
  readonly sha256: string;
}

interface SnapshotRow {
  readonly print_mode: "recursive" | "base-image-only";
  readonly artwork_sha256: string;
  readonly base_product_id: string;
  readonly byte_size: number;
  readonly configured_product_id: string;
  readonly content_type: string;
  readonly design_id: string;
  readonly design_revision_id: string;
  readonly placement_depth: number | null;
  readonly placement_width: number | null;
  readonly placement_x: number | null;
  readonly placement_y: number | null;
  readonly projection_version: "legacy-shirt-v1" | "safe-margin-v1" | null;
  readonly shopify_handle: string;
}

interface RevisionArtworkRow {
  readonly artwork_key: string;
  readonly byte_size: number;
  readonly content_type: string;
  readonly design_id: string;
  readonly design_revision_id: string;
  readonly sha256: string;
}

export interface ProductRepositoryShape {
  readonly createConfigured: (
    input: CreateConfiguredProductInput,
  ) => Effect.Effect<
    ProductDto,
    InvalidProductInput | ProductNotFound | DatabaseFailure
  >;
  readonly find: (
    id: string,
  ) => Effect.Effect<
    ProductDto,
    InvalidProductInput | ProductNotFound | DatabaseFailure
  >;
  readonly findFamily: (
    id: string,
  ) => Effect.Effect<
    readonly ProductDto[],
    InvalidProductInput | ProductNotFound | DatabaseFailure
  >;
  readonly findActiveRevisionSnapshot: (
    id: string,
  ) => Effect.Effect<
    ConfiguredProductRevisionSnapshotDto,
    InvalidProductInput | ProductNotFound | DatabaseFailure
  >;
  readonly findHistoricalRevisionSnapshot: (
    id: string,
    revisionId: string,
  ) => Effect.Effect<
    ConfiguredProductRevisionSnapshotDto,
    InvalidProductInput | ProductNotFound | DatabaseFailure
  >;
  readonly findRevisionArtwork: (
    revisionId: string,
  ) => Effect.Effect<
    RevisionArtworkRecord,
    InvalidProductInput | ProductNotFound | DatabaseFailure
  >;
}

export const ProductRepository = Context.GenericTag<ProductRepositoryShape>(
  "ForeverTee/ProductRepository",
);

function parseId(id: string) {
  return Schema.decodeUnknown(ProductId)(id).pipe(
    Effect.mapError(
      () => new InvalidProductInput({ message: "Invalid product id." }),
    ),
  );
}

function parseRevisionId(id: string) {
  return Schema.decodeUnknown(DesignRevisionId)(id).pipe(
    Effect.mapError(
      () => new InvalidProductInput({ message: "Invalid design revision id." }),
    ),
  );
}

function rowToProduct(row: typeof products.$inferSelect): ProductDto {
  return {
    id: row.id,
    baseProductId: row.baseProductId,
    designId: row.designId,
    designRevisionId: row.designRevisionId,
    placement: row.placementX === null || row.placementY === null ||
        row.placementWidth === null || row.placementDepth === null
      ? null
      : {
        x: row.placementX,
        y: row.placementY,
        width: row.placementWidth,
        depth: row.placementDepth,
      },
    projectionVersion: row.projectionVersion,
    ...(row.printMode === "base-image-only" ? { printMode: row.printMode } : {}),
    defaultColor: row.defaultColor,
    shopifyHandle: row.shopifyHandle,
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToSnapshot(row: SnapshotRow) {
  const baseProductSlug = baseProductSlugForId(row.base_product_id);
  if (
    !baseProductSlug || !row.projection_version ||
    row.placement_x === null || row.placement_y === null ||
    row.placement_width === null || row.placement_depth === null
  ) return undefined;
  const decoded = Schema.decodeUnknownOption(
    ConfiguredProductRevisionSnapshotSchema,
  )({
    configuredProductId: row.configured_product_id,
    baseProductId: row.base_product_id,
    designId: row.design_id,
    designRevisionId: row.design_revision_id,
    baseProductSlug,
    placement: {
      x: row.placement_x,
      y: row.placement_y,
      width: row.placement_width,
      depth: row.placement_depth,
    },
    projectionVersion: row.projection_version,
    ...(row.print_mode === "base-image-only" ? { printMode: row.print_mode } : {}),
    artworkSha256: row.artwork_sha256,
    contentType: row.content_type,
    byteSize: row.byte_size,
    shopifyHandle: row.shopify_handle,
    artworkUrl: `/v2/internal/design-revisions/${row.design_revision_id}/artwork`,
  });
  return Option.getOrUndefined(decoded);
}

function isValidRevisionArtworkRow(
  row: RevisionArtworkRow,
): row is RevisionArtworkRow {
  return (row.artwork_key === `designs/${row.design_id}/artwork/${row.sha256}` ||
      row.artwork_key === `designs/${row.design_id}/original/${row.sha256}`) &&
    /^image\/[a-z0-9.+-]+$/.test(row.content_type) &&
    Number.isSafeInteger(row.byte_size) &&
    row.byte_size > 0 &&
    row.byte_size <= MAX_DESIGN_ARTWORK_BYTES &&
    /^[0-9a-f]{64}$/.test(row.sha256);
}

const snapshotColumns = `
  SELECT
    products.id AS configured_product_id,
    products.base_product_id,
    products.design_id,
    products.design_revision_id,
    products.shopify_handle,
    products.placement_x,
    products.placement_y,
    products.placement_width,
    products.placement_depth,
    products.projection_version,
    products.print_mode,
    design_revisions.sha256 AS artwork_sha256,
    design_revisions.content_type,
    design_revisions.byte_size
  FROM products
  INNER JOIN design_revisions
    ON design_revisions.id = products.design_revision_id
    AND design_revisions.design_id = products.design_id
`;

const makeLive = (env: ProductRepositoryEnv): ProductRepositoryShape => ({
  createConfigured: ({ baseProductId: rawBaseProductId, designId }) =>
    Effect.gen(function*() {
      const baseProductId = yield* parseId(rawBaseProductId);
      const sourceProduct = yield* makeLive(env).find(baseProductId);
      const db = drizzle(env.DB);
      const findConfigured = () =>
        db.select().from(products).where(
          and(
            eq(products.designId, designId),
            eq(products.baseProductId, baseProductId),
            eq(products.status, "active"),
          ),
        ).get();
      const existing = yield* Effect.tryPromise({
        try: findConfigured,
        catch: (cause) =>
          new DatabaseFailure({ operation: "find configured product", cause }),
      });
      if (existing) return rowToProduct(existing);

      const design = yield* Effect.tryPromise({
        try: () => db.select().from(designs).where(eq(designs.id, designId)).get(),
        catch: (cause) =>
          new DatabaseFailure({ operation: "read configured design", cause }),
      });
      if (!design || design.status === "deleted" || design.ownerId !== null) {
        return yield* Effect.fail(new ProductNotFound({ id: designId }));
      }
      const baseProductSlug = baseProductSlugForId(sourceProduct.id);
      if (!baseProductSlug) {
        return yield* Effect.fail(new ProductNotFound({ id: baseProductId }));
      }
      const { artworkWidth, artworkHeight } = design;
      if (artworkWidth !== null && artworkHeight !== null) {
        const resolution = yield* Effect.tryPromise({
          try: () => productPrintResolution(
            env.DB, baseProductId, artworkWidth, artworkHeight,
            { cropX: design.cropX, cropY: design.cropY, cropZoom: design.cropZoom },
          ),
          catch: (cause) => new DatabaseFailure({ operation: "check print resolution", cause }),
        });
        if (!resolution?.safe) {
          return yield* Effect.fail(new InvalidProductInput({
            message: resolution
              ? `The artwork resolution is too low for the ${baseProductSlug} projection.`
              : "The product print dimensions are temporarily unavailable.",
          }));
        }
      }
      const placement = projectEditorPlacement({
        depth: design.depth,
        placementWidth: design.placementWidth,
        placementX: design.placementX,
        placementY: design.placementY,
      }, baseProductSlug);

      const now = new Date();
      const row = {
        id: crypto.randomUUID(),
        baseProductId: sourceProduct.baseProductId,
        designId,
        shopifyHandle: sourceProduct.shopifyHandle,
        placement,
        projectionVersion: SAFE_PRODUCT_PROJECTION_VERSION,
        defaultColor: design.defaultProductColor,
        createdAt: now,
      } satisfies ConfiguredProductRecord;

      yield* Effect.tryPromise({
        try: () => insertConfiguredProduct(env.DB, design, row),
        catch: (cause) =>
          new DatabaseFailure({ operation: "insert configured product", cause }),
      });

      const configured = yield* Effect.tryPromise({
        try: findConfigured,
        catch: (cause) =>
          new DatabaseFailure({ operation: "read configured product", cause }),
      });
      if (!configured) {
        return yield* Effect.fail(new ProductNotFound({ id: designId }));
      }
      return rowToProduct(configured);
    }),
  find: (rawId) =>
    Effect.gen(function*() {
      const id = yield* parseId(rawId);
      const db = drizzle(env.DB);
      const row = yield* Effect.tryPromise({
        try: () => db.select().from(products).where(eq(products.id, id)).get(),
        catch: (cause) =>
          new DatabaseFailure({ operation: "read product", cause }),
      });
      if (row?.status !== "active") {
        return yield* Effect.fail(new ProductNotFound({ id }));
      }
      const preparationId = row.designId && !row.designRevisionId ? yield* Effect.tryPromise({
        try: () => pendingProductPreparation(env.DB, row.designId ?? ""),
        catch: cause => new DatabaseFailure({ operation: "read product preparation", cause }),
      }) : undefined;
      return { ...rowToProduct(row), ...(preparationId ? { preparationId } : {}) };
    }),
  findFamily: (rawId) =>
    Effect.gen(function*() {
      const id = yield* parseId(rawId);
      const db = drizzle(env.DB);
      const product = yield* Effect.tryPromise({
        try: () => db.select().from(products).where(eq(products.id, id)).get(),
        catch: (cause) =>
          new DatabaseFailure({ operation: "read product family anchor", cause }),
      });
      if (product?.status !== "active") {
        return yield* Effect.fail(new ProductNotFound({ id }));
      }
      if (!product.designId) return [rowToProduct(product)];
      const designId = product.designId;
      // A shared design can have several immutable revisions. Switching product
      // type must preserve the version being viewed, including pending products.
      const sameRevision = product.designRevisionId === null
        ? isNull(products.designRevisionId)
        : eq(products.designRevisionId, product.designRevisionId);

      const family = yield* Effect.tryPromise({
        try: () => db.select().from(products).where(
          and(
            eq(products.designId, designId),
            sameRevision,
            eq(products.status, "active"),
          ),
        ).all(),
        catch: (cause) =>
          new DatabaseFailure({ operation: "read product family", cause }),
      });
      const preparationId = !product.designRevisionId ? yield* Effect.tryPromise({
        try: () => pendingProductPreparation(env.DB, designId),
        catch: cause => new DatabaseFailure({ operation: "read family preparation", cause }),
      }) : undefined;
      return family
        .sort((left, right) => left.baseProductId.localeCompare(right.baseProductId))
        .map(row => ({ ...rowToProduct(row), ...(preparationId ? { preparationId } : {}) }));
    }),
  findActiveRevisionSnapshot: (rawId) =>
    Effect.gen(function*() {
      const id = yield* parseId(rawId);
      const row = yield* Effect.tryPromise({
        try: () => env.DB.prepare(`${snapshotColumns}
          WHERE products.id = ?
            AND products.status = 'active'
            AND products.design_id IS NOT NULL
            AND products.design_revision_id IS NOT NULL
        `).bind(id).first<SnapshotRow>(),
        catch: (cause) =>
          new DatabaseFailure({ operation: "read active product revision", cause }),
      });
      const snapshot = row ? rowToSnapshot(row) : undefined;
      if (!snapshot) return yield* Effect.fail(new ProductNotFound({ id }));
      return snapshot;
    }),
  findHistoricalRevisionSnapshot: (rawId, rawRevisionId) =>
    Effect.gen(function*() {
      const id = yield* parseId(rawId);
      const revisionId = yield* parseRevisionId(rawRevisionId);
      const row = yield* Effect.tryPromise({
        try: () => env.DB.prepare(`${snapshotColumns}
          WHERE products.id = ?
            AND products.design_revision_id = ?
            AND products.design_id IS NOT NULL
        `).bind(id, revisionId).first<SnapshotRow>(),
        catch: (cause) =>
          new DatabaseFailure({ operation: "read historical product revision", cause }),
      });
      const snapshot = row ? rowToSnapshot(row) : undefined;
      if (!snapshot) return yield* Effect.fail(new ProductNotFound({ id }));
      return snapshot;
    }),
  findRevisionArtwork: (rawRevisionId) =>
    Effect.gen(function*() {
      const revisionId = yield* parseRevisionId(rawRevisionId);
      const row = yield* Effect.tryPromise({
        try: () => env.DB.prepare(`
          SELECT id AS design_revision_id, design_id, artwork_key, content_type,
            byte_size, sha256
          FROM design_revisions
          WHERE id = ?
        `).bind(revisionId).first<RevisionArtworkRow>(),
        catch: (cause) =>
          new DatabaseFailure({ operation: "read revision artwork", cause }),
      });
      if (!row || !isValidRevisionArtworkRow(row)) {
        return yield* Effect.fail(new ProductNotFound({ id: revisionId }));
      }
      return {
        designRevisionId: row.design_revision_id,
        artworkKey: row.artwork_key,
        contentType: row.content_type,
        byteSize: row.byte_size,
        sha256: row.sha256,
      };
    }),
});

export const makeProductRepositoryLayer = (env: ProductRepositoryEnv) =>
  Layer.succeed(ProductRepository, makeLive(env));
