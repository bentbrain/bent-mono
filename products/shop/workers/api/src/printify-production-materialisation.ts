import { INTERNAL_PRODUCT_DESCRIPTION, productionProductSku, productionProductTitle, productMatches, productReadbackIdentity } from "./printify-product-identity";
import { Data, Effect, Either, Schema } from "effect";

import {
  IntegrationConfigError,
  requirePrintifyProductionConfig,
  type IntegrationEnv,
} from "./integration-config";
import {
  createPrintAssetDeliveryUrl,
  printAssetGrantExpiry,
} from "./print-asset-delivery";
import {
  PrintifyCreateProductRequestSchema,
  PrintifyProductionClient,
  PrintifyUploadByUrlRequestSchema,
  makePrintifyProductionClientLayer,
  type PrintifyCreateProductRequest,
  type PrintifyProductionClientShape,
  type PrintifyProductionError,
  type PrintifyUploadedImage,
} from "./printify-production-client";

const MAX_RESOURCES_PER_RUN = 100;
const RESOURCE_LEASE_MS = 2 * 60 * 1_000;
const NonEmptyText = Schema.String.pipe(Schema.minLength(1));
const Sha256 = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const NullableText = Schema.NullOr(Schema.String);
const ResourceStatus = Schema.Literal(
  "pending",
  "creating",
  "verifying",
  "ready",
  "ambiguous",
  "failed",
  "archived",
);

const CandidateSchema = Schema.Struct({
  base_product_id: Schema.UUID,
  blueprint_id: PositiveInt,
  byte_size: PositiveInt,
  configured_product_id: Schema.UUID,
  design_revision_id: Schema.UUID,
  height_px: PositiveInt,
  paid_order_id: Schema.UUID,
  print_asset_id: Schema.UUID,
  print_asset_sha256: Sha256,
  print_geometry_key: NonEmptyText,
  print_provider_id: PositiveInt,
  printify_variant_id: PositiveInt,
  projection_version: Schema.Literal("legacy-shirt-v1", "safe-margin-v1"),
  retail_price_minor_units: PositiveInt,
  storage_key: NonEmptyText,
  width_px: PositiveInt,
});

type Candidate = Schema.Schema.Type<typeof CandidateSchema>;

const MediaRowSchema = Schema.Struct({
  file_name: NonEmptyText,
  id: Schema.UUID,
  lease_expires_at: Schema.NullOr(Schema.Int),
  lease_id: NullableText,
  provider_image_id: NullableText,
  status: ResourceStatus,
});

type MediaRow = Schema.Schema.Type<typeof MediaRowSchema>;

const ProductRowSchema = Schema.Struct({
  id: Schema.UUID,
  lease_expires_at: Schema.NullOr(Schema.Int),
  lease_id: NullableText,
  provider_product_id: NullableText,
  request_sha256: Sha256,
  status: ResourceStatus,
  title: NonEmptyText,
});

type ProductRow = Schema.Schema.Type<typeof ProductRowSchema>;

interface PrintifyMaterialisationEnv extends IntegrationEnv {
  readonly DB: D1Database;
}

export interface PrintifyMaterialisationReport {
  readonly candidates: number;
  readonly disabled: boolean;
  readonly exceptions: number;
  readonly mediaReady: number;
  readonly productsReady: number;
  readonly retried: number;
}

class PrintifyMaterialisationDatabaseError extends Data.TaggedError(
  "PrintifyMaterialisationDatabaseError",
)<{ readonly operation: string }> {}

type MaterialisationError =
  | PrintifyMaterialisationDatabaseError
  | PrintifyProductionError;

interface MutableReport {
  candidates: number;
  disabled: boolean;
  exceptions: number;
  mediaReady: number;
  productsReady: number;
  retried: number;
}

export function runScheduledPrintifyMaterialisation(
  env: PrintifyMaterialisationEnv,
  fetcher: typeof fetch = fetch,
  now = () => Date.now(),
): Promise<PrintifyMaterialisationReport> {
  let config: ReturnType<typeof requirePrintifyProductionConfig>;
  try {
    config = requirePrintifyProductionConfig(env);
  } catch (error) {
    if (error instanceof IntegrationConfigError) {
      return Promise.resolve(emptyReport(true));
    }
    return Promise.reject(error instanceof Error
      ? error
      : new Error("Printify production configuration failed."));
  }
  const program = Effect.gen(function*() {
    const report: MutableReport = emptyReport(false);
    const checkedAt = now();
    yield* markExpiredMutationLeasesAmbiguous(env.DB, checkedAt);
    const candidates = yield* readCandidates(env.DB, config.shopId);
    report.candidates = candidates.length;
    yield* Effect.forEach(
      candidates,
      (candidate) => materialiseCandidate(env, config, candidate, report, now),
      { concurrency: 4, discard: true },
    );
    return report;
  }).pipe(
    Effect.provide(makePrintifyProductionClientLayer(env, fetcher)),
  );
  return Effect.runPromise(program);
}

function materialiseCandidate(
  env: PrintifyMaterialisationEnv,
  config: ReturnType<typeof requirePrintifyProductionConfig>,
  candidate: Candidate,
  report: MutableReport,
  now: () => number,
): Effect.Effect<void, MaterialisationError, PrintifyProductionClientShape> {
  return Effect.gen(function*() {
    const blocked = yield* hasOpenException(env.DB, candidate.paid_order_id);
    if (blocked) return;
    const media = yield* ensureMediaRow(env.DB, candidate, now());
    const readyMedia = yield* materialiseMedia(
      env,
      config,
      candidate,
      media,
      report,
      now,
    );
    if (!readyMedia?.provider_image_id) return;
    const request = productRequest(candidate, readyMedia.provider_image_id);
    const requestSha256 = yield* sha256Json(request);
    const product = yield* ensureProductRow(
      env.DB,
      candidate,
      readyMedia.id,
      request,
      requestSha256,
      now(),
    );
    yield* materialiseProduct(
      env.DB,
      config.shopId,
      candidate,
      readyMedia,
      product,
      request,
      report,
      now,
    );
  });
}

function materialiseMedia(
  env: PrintifyMaterialisationEnv,
  config: ReturnType<typeof requirePrintifyProductionConfig>,
  candidate: Candidate,
  row: MediaRow,
  report: MutableReport,
  now: () => number,
): Effect.Effect<
  MediaRow | undefined,
  MaterialisationError,
  PrintifyProductionClientShape
> {
  if (row.status === "ready") return Effect.succeed(row);
  if (row.status === "ambiguous" || row.status === "failed" ||
      row.status === "archived") {
    return ensureResourceException(
      env.DB,
      candidate.paid_order_id,
      `PRINTIFY_MEDIA_${row.status.toUpperCase()}`,
      report,
      now(),
    ).pipe(Effect.as(undefined));
  }
  return Effect.gen(function*() {
    const client = yield* PrintifyProductionClient;
    const claimedAt = now();
    const leaseId = crypto.randomUUID();
    const claimed = yield* claimMedia(env.DB, row, leaseId, claimedAt, candidate.paid_order_id);
    if (!claimed) return undefined;

    let providerImageId = row.provider_image_id;
    if (!providerImageId) {
      const deliveryUrl = yield* Effect.tryPromise({
        try: () => createPrintAssetDeliveryUrl(
          config.assetOrigin,
          {
            assetId: candidate.print_asset_id,
            expiresAt: printAssetGrantExpiry(claimedAt),
            issuedAt: claimedAt,
            sha256: candidate.print_asset_sha256,
          },
          config.assetDeliverySecret,
        ),
        catch: () => new PrintifyMaterialisationDatabaseError({
          operation: "create print-asset delivery grant",
        }),
      });
      const uploadRequest = Schema.decodeUnknownSync(
        PrintifyUploadByUrlRequestSchema,
      )({ file_name: row.file_name, url: deliveryUrl });
      const uploadResult = yield* Effect.either(
        client.uploadImageByUrl(uploadRequest),
      );
      if (Either.isLeft(uploadResult)) {
        yield* handleMutationFailure(
          env.DB,
          "printify_media_copies",
          row.id,
          candidate.paid_order_id,
          leaseId,
          uploadResult.left,
          report,
          now(),
          "PRINTIFY_MEDIA",
        );
        return undefined;
      }
      providerImageId = uploadResult.right.id;
      yield* storeProviderId(
        env.DB,
        "printify_media_copies",
        "provider_image_id",
        row.id,
        providerImageId,
        leaseId,
        now(),
      );
    }

    const readResult = yield* Effect.either(
      client.getUploadedImage(providerImageId),
    );
    if (Either.isLeft(readResult)) {
      yield* handleReadFailure(
        env.DB,
        "printify_media_copies",
        row.id,
        candidate.paid_order_id,
        leaseId,
        readResult.left,
        report,
        now(),
        "PRINTIFY_MEDIA",
      );
      return undefined;
    }
    if (!mediaMatches(candidate, row.file_name, providerImageId, readResult.right)) {
      yield* failResource(
        env.DB,
        "printify_media_copies",
        row.id,
        candidate.paid_order_id,
        leaseId,
        "PRINTIFY_MEDIA_MISMATCH",
        report,
        now(),
      );
      return undefined;
    }
    yield* finalizeMedia(env.DB, row.id, leaseId, readResult.right, now());
    report.mediaReady += 1;
    yield* resolveException(env.DB, candidate.paid_order_id, "PRINTIFY_MEDIA", now());
    return {
      ...row,
      lease_expires_at: null,
      lease_id: null,
      provider_image_id: providerImageId,
      status: "ready",
    };
  });
}

function materialiseProduct(
  db: D1Database,
  shopId: string,
  candidate: Candidate,
  media: MediaRow,
  row: ProductRow,
  request: PrintifyCreateProductRequest,
  report: MutableReport,
  now: () => number,
): Effect.Effect<void, MaterialisationError, PrintifyProductionClientShape> {
  if (row.status === "ready") {
    return Effect.void;
  }
  if (row.status === "ambiguous" || row.status === "failed" ||
      row.status === "archived") {
    return ensureResourceException(
      db,
      candidate.paid_order_id,
      `PRINTIFY_PRODUCT_${row.status.toUpperCase()}`,
      report,
      now(),
    );
  }
  return Effect.gen(function*() {
    const client = yield* PrintifyProductionClient;
    const claimedAt = now();
    const leaseId = crypto.randomUUID();
    const claimed = yield* claimProduct(db, row, leaseId, claimedAt, candidate.paid_order_id);
    if (!claimed) return;

    let providerProductId = row.provider_product_id;
    if (!providerProductId) {
      const createResult = yield* Effect.either(client.createProduct(request));
      if (Either.isLeft(createResult)) {
        yield* handleMutationFailure(
          db,
          "printify_production_products",
          row.id,
          candidate.paid_order_id,
          leaseId,
          createResult.left,
          report,
          now(),
          "PRINTIFY_PRODUCT",
        );
        return;
      }
      providerProductId = createResult.right.id;
      yield* storeProviderId(
        db,
        "printify_production_products",
        "provider_product_id",
        row.id,
        providerProductId,
        leaseId,
        now(),
      );
    }

    const readResult = yield* Effect.either(client.getProduct(providerProductId));
    if (Either.isLeft(readResult)) {
      yield* handleReadFailure(
        db,
        "printify_production_products",
        row.id,
        candidate.paid_order_id,
        leaseId,
        readResult.left,
        report,
        now(),
        "PRINTIFY_PRODUCT",
      );
      return;
    }
    const numericShopId = Number(shopId);
    if (!Number.isSafeInteger(numericShopId) || numericShopId <= 0 ||
        !media.provider_image_id ||
        !productMatches(
          candidate,
          media.provider_image_id,
          providerProductId,
          row.title,
          numericShopId,
          readResult.right,
        )) {
      yield* failResource(
        db,
        "printify_production_products",
        row.id,
        candidate.paid_order_id,
        leaseId,
        "PRINTIFY_PRODUCT_MISMATCH",
        report,
        now(),
      );
      return;
    }
    const readbackSha256 = yield* sha256Json(
      productReadbackIdentity(readResult.right),
    );
    yield* finalizeProduct(
      db,
      row.id,
      leaseId,
      readbackSha256,
      productionProductSku(candidate),
      now(),
    );
    report.productsReady += 1;
    yield* resolveException(db, candidate.paid_order_id, "PRINTIFY_PRODUCT", now());
  });
}

function readCandidates(db: D1Database, shopId: string) {
  return Effect.tryPromise({
    try: () => db.prepare(`
      SELECT orders.id AS paid_order_id,
        lines.configured_product_id, lines.design_revision_id,
        lines.base_product_id, lines.projection_version,
        lines.print_geometry_key, lines.print_asset_id,
        lines.print_asset_sha256, lines.printify_variant_id,
        lines.retail_price_minor_units,
        coalesce(objects.storage_key, assets.storage_key) AS storage_key,
        assets.byte_size, assets.width_px, assets.height_px,
        catalogue.blueprint_id, catalogue.print_provider_id
      FROM paid_orders AS orders
      JOIN paid_order_lines AS lines ON lines.paid_order_id = orders.id
        AND lines.retail_price_minor_units IS NOT NULL
      JOIN print_assets AS assets ON assets.id = lines.print_asset_id
        AND assets.sha256 = lines.print_asset_sha256
        AND assets.status = 'ready' AND assets.content_type = 'image/png'
      LEFT JOIN print_asset_objects AS objects
        ON objects.sha256 = assets.object_sha256
      JOIN shopify_variant_mapping_snapshots AS mapping_snapshot
        ON mapping_snapshot.id = lines.variant_mapping_snapshot_id
        AND mapping_snapshot.base_product_id = lines.base_product_id
      JOIN printify_catalogue_snapshots AS catalogue
        ON catalogue.id = mapping_snapshot.catalogue_snapshot_id
        AND catalogue.base_product_id = lines.base_product_id
        AND catalogue.shop_id = ?
      JOIN printify_catalogue_variants AS catalogue_variant
        ON catalogue_variant.snapshot_id = catalogue.id
        AND catalogue_variant.printify_variant_id = lines.printify_variant_id
        AND catalogue_variant.available = 1
        AND lines.print_geometry_key = lower(catalogue_variant.decoration_method)
          || ':' || catalogue_variant.print_width || 'x'
          || catalogue_variant.print_height
      WHERE orders.status = 'fulfilment_locked'
        AND NOT EXISTS (
          SELECT 1 FROM paid_order_lines restricted_line JOIN products configured ON configured.id = restricted_line.configured_product_id
          WHERE restricted_line.paid_order_id = orders.id AND configured.status IN ('suspended', 'unpublished', 'retired')
        )
        AND NOT EXISTS (
          SELECT 1 FROM fulfilment_exceptions
          WHERE paid_order_id = orders.id AND status = 'open'
        )
        AND NOT EXISTS (
          SELECT 1 FROM printify_production_products AS production_product
          WHERE production_product.configured_product_id =
              lines.configured_product_id
            AND production_product.design_revision_id =
              lines.design_revision_id
            AND production_product.base_product_id = lines.base_product_id
            AND production_product.projection_version =
              lines.projection_version
            AND production_product.print_geometry_key =
              lines.print_geometry_key
            AND production_product.print_asset_id = lines.print_asset_id
            AND production_product.print_asset_sha256 =
              lines.print_asset_sha256
            AND production_product.printify_variant_id =
              lines.printify_variant_id
            AND production_product.retail_price_minor_units =
              lines.retail_price_minor_units
            AND production_product.status = 'ready'
        )
      ORDER BY orders.fulfilment_locked_at, lines.line_position
      LIMIT ?
    `).bind(shopId, MAX_RESOURCES_PER_RUN).all(),
    catch: () => new PrintifyMaterialisationDatabaseError({
      operation: "read materialisation candidates",
    }),
  }).pipe(
    Effect.flatMap((result) => Effect.forEach(
      result.results,
      (row) => Schema.decodeUnknown(CandidateSchema)(row).pipe(
        Effect.mapError(() => new PrintifyMaterialisationDatabaseError({
          operation: "decode materialisation candidate",
        })),
      ),
    )),
  );
}

function ensureMediaRow(db: D1Database, candidate: Candidate, now: number) {
  const id = crypto.randomUUID();
  const fileName =
    `bent-${candidate.print_asset_id}-${candidate.print_asset_sha256.slice(0, 16)}.png`;
  return databaseEffect("ensure Printify media row", () => db.batch([
    db.prepare(`
      INSERT INTO printify_media_copies (
        id, print_asset_id, print_asset_sha256, file_name, status,
        attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (print_asset_id, print_asset_sha256) DO NOTHING
    `).bind(
      id,
      candidate.print_asset_id,
      candidate.print_asset_sha256,
      fileName,
      now,
      now,
    ),
    db.prepare(`
      SELECT id, file_name, provider_image_id, status, lease_id,
        lease_expires_at
      FROM printify_media_copies
      WHERE print_asset_id = ? AND print_asset_sha256 = ?
    `).bind(candidate.print_asset_id, candidate.print_asset_sha256),
  ])).pipe(
    Effect.flatMap((results) => decodeFirstResult(
      MediaRowSchema,
      results[1]?.results[0],
      "decode Printify media row",
    )),
  );
}

function ensureProductRow(
  db: D1Database,
  candidate: Candidate,
  mediaCopyId: string,
  request: PrintifyCreateProductRequest,
  requestSha256: string,
  now: number,
) {
  const id = crypto.randomUUID();
  return databaseEffect("ensure Printify product row", () => db.batch([
    db.prepare(`
      INSERT INTO printify_production_products (
        id, configured_product_id, design_revision_id, base_product_id,
        projection_version, print_geometry_key, print_asset_id,
        print_asset_sha256, media_copy_id, printify_variant_id,
        blueprint_id, print_provider_id, retail_price_minor_units,
        title, request_sha256, status, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (
        configured_product_id, design_revision_id, base_product_id,
        projection_version, print_geometry_key, print_asset_id,
        print_asset_sha256, printify_variant_id, retail_price_minor_units
      ) DO NOTHING
    `).bind(
      id,
      candidate.configured_product_id,
      candidate.design_revision_id,
      candidate.base_product_id,
      candidate.projection_version,
      candidate.print_geometry_key,
      candidate.print_asset_id,
      candidate.print_asset_sha256,
      mediaCopyId,
      candidate.printify_variant_id,
      candidate.blueprint_id,
      candidate.print_provider_id,
      candidate.retail_price_minor_units,
      request.title,
      requestSha256,
      now,
      now,
    ),
    db.prepare(`
      SELECT id, provider_product_id, request_sha256, status, title,
        lease_id, lease_expires_at
      FROM printify_production_products
      WHERE configured_product_id = ? AND design_revision_id = ?
        AND base_product_id = ? AND projection_version = ?
        AND print_geometry_key = ? AND print_asset_id = ?
        AND print_asset_sha256 = ? AND printify_variant_id = ?
        AND retail_price_minor_units = ?
    `).bind(
      candidate.configured_product_id,
      candidate.design_revision_id,
      candidate.base_product_id,
      candidate.projection_version,
      candidate.print_geometry_key,
      candidate.print_asset_id,
      candidate.print_asset_sha256,
      candidate.printify_variant_id,
      candidate.retail_price_minor_units,
    ),
  ])).pipe(
    Effect.flatMap((results) => decodeFirstResult(
      ProductRowSchema,
      results[1]?.results[0],
      "decode Printify product row",
    )),
    Effect.flatMap((row) => row.request_sha256 === requestSha256
      ? Effect.succeed(row)
      : Effect.fail(new PrintifyMaterialisationDatabaseError({
        operation: "verify immutable Printify product request",
      }))),
  );
}

function claimMedia(
  db: D1Database,
  row: MediaRow,
  leaseId: string,
  now: number,
  paidOrderId: string,
) {
  const nextStatus = row.provider_image_id ? "verifying" : "creating";
  return claimResource(
    db,
    "printify_media_copies",
    row.id,
    row.status,
    nextStatus,
    leaseId,
    now,
    paidOrderId,
  );
}

function claimProduct(
  db: D1Database,
  row: ProductRow,
  leaseId: string,
  now: number,
  paidOrderId: string,
) {
  const nextStatus = row.provider_product_id ? "verifying" : "creating";
  return claimResource(
    db,
    "printify_production_products",
    row.id,
    row.status,
    nextStatus,
    leaseId,
    now,
    paidOrderId,
  );
}

function claimResource(
  db: D1Database,
  table: ResourceTable,
  id: string,
  currentStatus: MediaRow["status"],
  nextStatus: "creating" | "verifying",
  leaseId: string,
  now: number,
  paidOrderId: string,
) {
  return databaseEffect(`claim ${table}`, () => db.prepare(`
    UPDATE ${table}
    SET status = ?, lease_id = ?, lease_expires_at = ?,
      attempt_count = attempt_count + 1, last_error_code = NULL,
      updated_at = ?
    WHERE id = ? AND status = ? AND lease_id IS NULL
      AND EXISTS (SELECT 1 FROM paid_orders WHERE id = ? AND status = 'fulfilment_locked')
      AND NOT EXISTS (
        SELECT 1 FROM paid_order_lines line JOIN products configured ON configured.id = line.configured_product_id
        WHERE line.paid_order_id = ? AND configured.status IN ('suspended', 'unpublished', 'retired')
      )
      AND NOT EXISTS (SELECT 1 FROM fulfilment_exceptions WHERE paid_order_id = ? AND status = 'open')
  `).bind(
    nextStatus,
    leaseId,
    now + RESOURCE_LEASE_MS,
    now,
    id,
    currentStatus,
    paidOrderId,
    paidOrderId,
    paidOrderId,
  ).run()).pipe(Effect.map((result) => result.meta.changes === 1));
}

type ResourceTable =
  | "printify_media_copies"
  | "printify_production_products";

type ProviderIdColumn = "provider_image_id" | "provider_product_id";

function storeProviderId(
  db: D1Database,
  table: ResourceTable,
  column: ProviderIdColumn,
  id: string,
  providerId: string,
  leaseId: string,
  now: number,
) {
  return databaseEffect(`store ${column}`, () => db.prepare(`
    UPDATE ${table}
    SET ${column} = ?, status = 'verifying', updated_at = ?
    WHERE id = ? AND lease_id = ? AND status = 'creating'
  `).bind(providerId, now, id, leaseId).run()).pipe(
    Effect.flatMap((result) => result.meta.changes === 1
      ? Effect.void
      : Effect.fail(new PrintifyMaterialisationDatabaseError({
        operation: `store ${column} fence`,
      }))),
  );
}

function finalizeMedia(
  db: D1Database,
  id: string,
  leaseId: string,
  image: PrintifyUploadedImage,
  now: number,
) {
  return databaseEffect("finalize Printify media", () => db.prepare(`
    UPDATE printify_media_copies
    SET status = 'ready', lease_id = NULL, lease_expires_at = NULL,
      provider_mime_type = ?, provider_byte_size = ?, provider_width_px = ?,
      provider_height_px = ?, provider_preview_url = ?, last_error_code = NULL,
      verified_at = ?, updated_at = ?
    WHERE id = ? AND lease_id = ? AND status = 'verifying'
      AND provider_image_id = ?
  `).bind(
    image.mime_type,
    image.size,
    image.width,
    image.height,
    image.preview_url,
    now,
    now,
    id,
    leaseId,
    image.id,
  ).run()).pipe(
    Effect.flatMap((result) => result.meta.changes === 1
      ? Effect.void
      : Effect.fail(new PrintifyMaterialisationDatabaseError({
        operation: "finalize Printify media fence",
      }))),
  );
}

function finalizeProduct(
  db: D1Database,
  id: string,
  leaseId: string,
  readbackSha256: string,
  providerSku: string,
  now: number,
) {
  return databaseEffect("finalize Printify product", () => db.prepare(`
    UPDATE printify_production_products
    SET status = 'ready', lease_id = NULL, lease_expires_at = NULL,
      readback_sha256 = ?, provider_sku = ?, last_error_code = NULL, verified_at = ?,
      updated_at = ?
    WHERE id = ? AND lease_id = ? AND status = 'verifying'
      AND provider_product_id IS NOT NULL
  `).bind(readbackSha256, providerSku, now, now, id, leaseId).run()).pipe(
    Effect.flatMap((result) => result.meta.changes === 1
      ? Effect.void
      : Effect.fail(new PrintifyMaterialisationDatabaseError({
        operation: "finalize Printify product fence",
      }))),
  );
}

function handleMutationFailure(
  db: D1Database,
  table: ResourceTable,
  id: string,
  orderId: string,
  leaseId: string,
  error: PrintifyProductionError,
  report: MutableReport,
  now: number,
  exceptionPrefix: "PRINTIFY_MEDIA" | "PRINTIFY_PRODUCT",
) {
  if (error._tag === "PrintifyProductionRateLimitError") {
    report.retried += 1;
    return resetResource(db, table, id, leaseId, "pending", error._tag, now);
  }
  if (error._tag === "PrintifyAmbiguousMutationError") {
    return failResource(
      db,
      table,
      id,
      orderId,
      leaseId,
      `${exceptionPrefix}_AMBIGUOUS`,
      report,
      now,
      "ambiguous",
    );
  }
  return failResource(
    db,
    table,
    id,
    orderId,
    leaseId,
    `${exceptionPrefix}_FAILED`,
    report,
    now,
  );
}

function handleReadFailure(
  db: D1Database,
  table: ResourceTable,
  id: string,
  orderId: string,
  leaseId: string,
  error: PrintifyProductionError,
  report: MutableReport,
  now: number,
  exceptionPrefix: "PRINTIFY_MEDIA" | "PRINTIFY_PRODUCT",
) {
  if (error._tag === "PrintifyProductionDependencyError" ||
      error._tag === "PrintifyProductionRateLimitError") {
    report.retried += 1;
    return resetResource(db, table, id, leaseId, "verifying", error._tag, now);
  }
  return failResource(
    db,
    table,
    id,
    orderId,
    leaseId,
    `${exceptionPrefix}_READBACK_FAILED`,
    report,
    now,
  );
}

function resetResource(
  db: D1Database,
  table: ResourceTable,
  id: string,
  leaseId: string,
  status: "pending" | "verifying",
  errorCode: string,
  now: number,
) {
  return databaseEffect(`reset ${table}`, () => db.prepare(`
    UPDATE ${table}
    SET status = ?, lease_id = NULL, lease_expires_at = NULL,
      last_error_code = ?, updated_at = ?
    WHERE id = ? AND lease_id = ?
  `).bind(status, errorCode, now, id, leaseId).run()).pipe(Effect.asVoid);
}

function failResource(
  db: D1Database,
  table: ResourceTable,
  id: string,
  orderId: string,
  leaseId: string,
  errorCode: string,
  report: MutableReport,
  now: number,
  status: "failed" | "ambiguous" = "failed",
) {
  report.exceptions += 1;
  return databaseEffect(`fail ${table}`, () => db.batch([
    db.prepare(`
      UPDATE ${table}
      SET status = ?, lease_id = NULL, lease_expires_at = NULL,
        last_error_code = ?, updated_at = ?
      WHERE id = ? AND lease_id = ?
    `).bind(status, errorCode, now, id, leaseId),
    db.prepare(`
      INSERT INTO fulfilment_exceptions (
        id, paid_order_id, code, summary, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, 'open', ?, NULL)
      ON CONFLICT (id) DO UPDATE SET summary = excluded.summary,
        status = 'open', resolved_at = NULL
    `).bind(
      `${orderId}:${errorCode}`,
      orderId,
      errorCode,
      "Printify production resource requires reconciliation.",
      now,
    ),
  ])).pipe(Effect.asVoid);
}

function ensureResourceException(
  db: D1Database,
  orderId: string,
  errorCode: string,
  report: MutableReport,
  now: number,
) {
  report.exceptions += 1;
  return databaseEffect("ensure Printify resource exception", () => db.prepare(`
    INSERT INTO fulfilment_exceptions (
      id, paid_order_id, code, summary, status, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, 'open', ?, NULL)
    ON CONFLICT (id) DO UPDATE SET summary = excluded.summary,
      status = 'open', resolved_at = NULL
  `).bind(
    `${orderId}:${errorCode}`,
    orderId,
    errorCode,
    "Printify production resource requires reconciliation.",
    now,
  ).run()).pipe(Effect.asVoid);
}

function hasOpenException(db: D1Database, orderId: string) {
  return databaseEffect("check fulfilment exception", () => db.prepare(`
    SELECT id FROM fulfilment_exceptions
    WHERE paid_order_id = ? AND status = 'open'
    LIMIT 1
  `).bind(orderId).first()).pipe(Effect.map((row) => row !== null));
}

function resolveException(
  db: D1Database,
  orderId: string,
  codePrefix: "PRINTIFY_MEDIA" | "PRINTIFY_PRODUCT",
  now: number,
) {
  return databaseEffect("resolve Printify resource exceptions", () => db.prepare(`
    UPDATE fulfilment_exceptions
    SET status = 'resolved', resolved_at = ?
    WHERE paid_order_id = ? AND status = 'open' AND code LIKE ?
  `).bind(now, orderId, `${codePrefix}%`).run()).pipe(Effect.asVoid);
}

function markExpiredMutationLeasesAmbiguous(db: D1Database, now: number) {
  return databaseEffect("fence expired Printify mutations", () => db.batch([
    db.prepare(`
      UPDATE printify_media_copies
      SET status = 'ambiguous', lease_id = NULL, lease_expires_at = NULL,
        last_error_code = 'PRINTIFY_MEDIA_LEASE_EXPIRED', updated_at = ?
      WHERE status = 'creating' AND lease_expires_at <= ?
    `).bind(now, now),
    db.prepare(`
      UPDATE printify_production_products
      SET status = 'ambiguous', lease_id = NULL, lease_expires_at = NULL,
        last_error_code = 'PRINTIFY_PRODUCT_LEASE_EXPIRED', updated_at = ?
      WHERE status = 'creating' AND lease_expires_at <= ?
    `).bind(now, now),
    db.prepare(`
      UPDATE printify_media_copies
      SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'verifying' AND lease_expires_at <= ?
    `).bind(now, now),
    db.prepare(`
      UPDATE printify_production_products
      SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'verifying' AND lease_expires_at <= ?
    `).bind(now, now),
  ])).pipe(Effect.asVoid);
}

function productRequest(
  candidate: Candidate,
  providerImageId: string,
): PrintifyCreateProductRequest {
  return Schema.decodeUnknownSync(PrintifyCreateProductRequestSchema)({
    blueprint_id: candidate.blueprint_id,
    description: INTERNAL_PRODUCT_DESCRIPTION,
    print_areas: [{
      placeholders: [{
        images: [{
          angle: 0,
          id: providerImageId,
          scale: 1,
          x: 0.5,
          y: 0.5,
        }],
        position: "front",
      }],
      variant_ids: [candidate.printify_variant_id],
    }],
    print_provider_id: candidate.print_provider_id,
    title: productionProductTitle(candidate),
    variants: [{
      id: candidate.printify_variant_id,
      is_enabled: true,
      price: candidate.retail_price_minor_units,
      sku: productionProductSku(candidate),
    }],
  });
}

function mediaMatches(
  candidate: Candidate,
  fileName: string,
  providerImageId: string,
  image: PrintifyUploadedImage,
) {
  return image.id === providerImageId && image.file_name === fileName &&
    image.mime_type === "image/png" && image.size === candidate.byte_size &&
    image.width === candidate.width_px && image.height === candidate.height_px;
}

function sha256Json(value: unknown) {
  return Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      );
      return Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    },
    catch: () => new PrintifyMaterialisationDatabaseError({
      operation: "hash Printify resource identity",
    }),
  });
}

function databaseEffect<Success>(
  operation: string,
  run: () => Promise<Success>,
) {
  return Effect.tryPromise({
    try: run,
    catch: () => new PrintifyMaterialisationDatabaseError({ operation }),
  });
}

function decodeFirstResult<Decoded, Encoded>(
  schema: Schema.Schema<Decoded, Encoded>,
  value: unknown,
  operation: string,
) {
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(() => new PrintifyMaterialisationDatabaseError({ operation })),
  );
}

function emptyReport(disabled: boolean): MutableReport {
  return {
    candidates: 0,
    disabled,
    exceptions: 0,
    mediaReady: 0,
    productsReady: 0,
    retried: 0,
  };
}
