import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const designs = sqliteTable(
  "designs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id"),
    artworkJobId: text("artwork_job_id"),
    removeBackground: integer("remove_background"),
    artworkKey: text("artwork_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    artworkWidth: integer("artwork_width"),
    artworkHeight: integer("artwork_height"),
    sha256: text("sha256").notNull(),
    cropX: real("crop_x").notNull(),
    cropY: real("crop_y").notNull(),
    cropZoom: real("crop_zoom").notNull(),
    placementX: real("placement_x").notNull(),
    placementY: real("placement_y").notNull(),
    placementWidth: real("placement_width").notNull(),
    depth: integer("depth").notNull(),
    status: text("status", {
      enum: ["creating", "processing", "ready", "deleted"],
    })
      .notNull()
      .default("ready"),
    safetyScreeningDecision: text("safety_screening_decision", {
      enum: ["allowed"],
    }),
    safetyScreeningModel: text("safety_screening_model"),
    defaultProductColor: text("default_product_color", {
      enum: ["Black", "White"],
    }).notNull().default("White"),
    defaultProductColorModel: text("default_product_color_model"),
    defaultProductColorStatus: text("default_product_color_status", {
      enum: ["pending", "complete", "fallback"],
    }).notNull().default("fallback"),
    version: integer("version").notNull().default(0),
    finalizedAt: integer("finalized_at", { mode: "timestamp_ms" }),
    legacyClaimExpiresAt: integer("legacy_claim_expires_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("designs_owner_updated_idx").on(table.ownerId, table.updatedAt),
    index("designs_owner_finalized_idx").on(table.ownerId, sql`${table.finalizedAt} DESC`, sql`${table.id} DESC`)
      .where(sql`${table.finalizedAt} IS NOT NULL AND ${table.deletedAt} IS NULL AND ${table.status} = 'ready'`),
    index("designs_abandoned_updated_idx").on(table.updatedAt, table.id)
      .where(sql`${table.finalizedAt} IS NULL AND ${table.deletedAt} IS NULL`),
  ],
);

export const designArtworkSources = sqliteTable("design_artwork_sources", {
  designId: text("design_id").notNull().references(() => designs.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["original", "cutout"] }).notNull(),
  artworkKey: text("artwork_key").notNull(),
  sha256: text("sha256").notNull(),
  byteSize: integer("byte_size").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
}, table => [primaryKey({ columns: [table.designId, table.kind] }), index("design_artwork_sources_key_idx").on(table.artworkKey)]);

export const artworkPreparationJobs = sqliteTable("artwork_preparation_jobs", {
  id: text("id").primaryKey(),
  designId: text("design_id").notNull().references(() => designs.id, { onDelete: "cascade" }),
  sourceKey: text("source_key").notNull(),
  sourceBytes: integer("source_bytes").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  status: text("status", { enum: ["pending", "processing", "complete", "failed"] }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull(),
  leaseToken: text("lease_token"),
  sourceDeletedAt: integer("source_deleted_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [index("artwork_preparation_jobs_due_idx").on(table.status, table.nextAttemptAt)]);

export const designRevisions = sqliteTable(
  "design_revisions",
  {
    id: text("id").primaryKey(),
    designId: text("design_id")
      .notNull()
      .references(() => designs.id),
    fingerprint: text("fingerprint").notNull(),
    artworkKey: text("artwork_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    artworkWidth: integer("artwork_width"),
    artworkHeight: integer("artwork_height"),
    sha256: text("sha256").notNull(),
    cropX: real("crop_x").notNull(),
    cropY: real("crop_y").notNull(),
    cropZoom: real("crop_zoom").notNull(),
    legacyPlacementX: real("placement_x").notNull(),
    legacyPlacementY: real("placement_y").notNull(),
    legacyPlacementWidth: real("placement_width").notNull(),
    legacyDepth: integer("depth").notNull(),
    videoPlacementX: real("video_placement_x"),
    videoPlacementY: real("video_placement_y"),
    videoPlacementWidth: real("video_placement_width"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("design_revisions_design_created_idx").on(
      table.designId,
      table.createdAt,
    ),
    uniqueIndex("design_revisions_design_fingerprint_unique_idx").on(
      table.designId,
      table.fingerprint,
    ),
  ],
);

export const designUploadGrants = sqliteTable(
  "design_upload_grants",
  {
    progressive: integer("progressive").notNull().default(0),
    tokenHash: text("token_hash").primaryKey(),
    designId: text("design_id")
      .notNull()
      .references(() => designs.id),
    ownerId: text("owner_id").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    contentType: text("content_type").notNull(),
    maxBytes: integer("max_bytes").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("design_upload_grants_design_created_idx").on(
      table.designId,
      table.createdAt,
    ),
    index("design_upload_grants_expires_idx").on(table.expiresAt),
  ],
);

export const paidOperationUsage = sqliteTable(
  "paid_operation_usage",
  {
    quotaKey: text("quota_key").notNull(),
    usageDate: text("usage_date").notNull(),
    operationCount: integer("operation_count").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.quotaKey, table.usageDate] }),
    index("paid_operation_usage_updated_idx").on(table.updatedAt),
  ],
);

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    baseProductId: text("base_product_id").notNull(),
    designId: text("design_id").references(() => designs.id),
    designRevisionId: text("design_revision_id").references(
      () => designRevisions.id,
    ),
    printMode: text("print_mode", { enum: ["recursive", "base-image-only"] }).notNull().default("recursive"),
    videoRecursiveRevisionId: text("video_recursive_revision_id").references(() => designRevisions.id),
    videoDesignRevisionId: text("video_design_revision_id").references(() => designRevisions.id),
    placementX: real("placement_x"),
    placementY: real("placement_y"),
    placementWidth: real("placement_width"),
    placementDepth: integer("placement_depth"),
    projectionVersion: text("projection_version", {
      enum: ["legacy-shirt-v1", "safe-margin-v1"],
    }),
    defaultColor: text("default_color", {
      enum: ["Black", "White"],
    }).notNull().default("White"),
    shopifyHandle: text("shopify_handle").notNull(),
    status: text("status", { enum: ["active", "suspended", "unpublished", "retired", "deleted"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("products_base_created_idx").on(table.baseProductId, table.createdAt),
    index("products_design_idx").on(table.designId),
    index("products_design_revision_idx").on(table.designRevisionId),
    uniqueIndex("products_active_design_revision_base_product_unique_idx")
      .on(table.designRevisionId, table.baseProductId)
      .where(
        sql`${table.designRevisionId} IS NOT NULL AND ${table.status} = 'active'`,
      ),
    uniqueIndex("products_active_pending_design_base_product_unique_idx")
      .on(table.designId, table.baseProductId)
      .where(
        sql`${table.designId} IS NOT NULL AND ${table.designRevisionId} IS NULL AND ${table.status} = 'active'`,
      ),
  ],
);

export const storyVideoJobs = sqliteTable(
  "story_video_jobs",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    designRevisionId: text("design_revision_id")
      .notNull()
      .references(() => designRevisions.id),
    colour: text("colour", { enum: ["Black", "Cream", "White"] }).notNull(),
    rendererVersion: text("renderer_version").notNull(),
    storyKey: text("story_key").notNull().unique(),
    status: text("status", {
      enum: ["queued", "rendering", "ready", "failed"],
    })
      .notNull()
      .default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    executionId: text("execution_id"),
    outputByteSize: integer("output_byte_size"),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    renderedAt: integer("rendered_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("story_video_jobs_product_colour_renderer_unique_idx").on(
      table.productId,
      table.colour,
      table.rendererVersion,
    ),
    index("story_video_jobs_revision_status_idx").on(
      table.designRevisionId,
      table.status,
      table.createdAt,
    ),
    index("story_video_jobs_product_status_idx").on(
      table.productId,
      table.status,
    ),
    index("story_video_jobs_status_updated_idx").on(table.status, table.updatedAt),
    index("story_video_jobs_recovery_idx").on(table.rendererVersion, table.updatedAt)
      .where(sql`${table.status} IN ('queued', 'failed')`),
  ],
);

export const printAssetRetries = sqliteTable(
  "print_asset_retries",
  {
    configuredProductId: text("configured_product_id").primaryKey().notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    attemptCount: integer("attempt_count").notNull(),
    claimId: text("claim_id"),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [check("print_asset_retries_attempt_count", sql`${table.attemptCount} BETWEEN 1 AND 16`)],
);

export const printAssetObjects = sqliteTable(
  "print_asset_objects",
  {
    sha256: text("sha256").primaryKey(),
    storageKey: text("storage_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
);

export const printAssets = sqliteTable(
  "print_assets",
  {
    id: text("id").primaryKey(),
    configuredProductId: text("configured_product_id")
      .notNull()
      .references(() => products.id),
    designRevisionId: text("design_revision_id")
      .notNull()
      .references(() => designRevisions.id),
    baseProductId: text("base_product_id")
      .notNull()
      .references(() => products.id),
    projectionVersion: text("projection_version").notNull(),
    geometryKey: text("geometry_key").notNull(),
    storageKey: text("storage_key").unique(),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    widthPx: integer("width_px"),
    heightPx: integer("height_px"),
    sha256: text("sha256"),
    objectSha256: text("object_sha256").references(
      () => printAssetObjects.sha256,
    ),
    status: text("status", {
      enum: ["pending", "ready", "failed", "deleted"],
    }).notNull().default("pending"),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    readyAt: integer("ready_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("print_assets_product_geometry_unique_idx").on(
      table.configuredProductId,
      table.geometryKey,
    ),
    uniqueIndex("print_assets_order_identity_unique_idx").on(
      table.id,
      table.configuredProductId,
      table.designRevisionId,
      table.baseProductId,
      table.projectionVersion,
      table.geometryKey,
      table.sha256,
    ),
    index("print_assets_revision_base_idx").on(
      table.designRevisionId,
      table.baseProductId,
      table.status,
    ),
    index("print_assets_object_sha256_idx").on(table.objectSha256),
  ],
);

export const storageTestFixtures = sqliteTable(
  "storage_test_fixtures",
  {
    designId: text("design_id")
      .primaryKey()
      .references(() => designs.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    purpose: text("purpose", { enum: ["native-qualification"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("storage_test_fixtures_expiry_idx").on(
      table.expiresAt,
      table.designId,
    ),
    index("storage_test_fixtures_run_idx").on(table.runId, table.designId),
  ],
);

export const storageGcCursors = sqliteTable(
  "storage_gc_cursors",
  {
    bucket: text("bucket", {
      enum: ["design-artwork", "story-videos"],
    }).primaryKey(),
    cursor: text("cursor"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
);

export const designAssetDeletions = sqliteTable(
  "design_asset_deletions",
  {
    bucket: text("bucket", { enum: ["design-artwork", "story-videos"] }).notNull(),
    storageKey: text("storage_key").notNull(),
    designId: text("design_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bucket, table.storageKey] }),
    index("design_asset_deletions_pending_idx").on(table.createdAt),
  ],
);

export const printifyMediaCopies = sqliteTable(
  "printify_media_copies",
  {
    id: text("id").primaryKey(),
    printAssetId: text("print_asset_id").notNull().references(() => printAssets.id),
    printAssetSha256: text("print_asset_sha256").notNull(),
    providerImageId: text("provider_image_id").unique(),
    fileName: text("file_name").notNull().unique(),
    status: text("status", {
      enum: [
        "pending", "creating", "verifying", "ready", "ambiguous", "failed",
        "archived",
      ],
    }).notNull().default("pending"),
    leaseId: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    providerMimeType: text("provider_mime_type"),
    providerByteSize: integer("provider_byte_size"),
    providerWidthPx: integer("provider_width_px"),
    providerHeightPx: integer("provider_height_px"),
    providerPreviewUrl: text("provider_preview_url"),
    lastErrorCode: text("last_error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("printify_media_copies_asset_unique_idx").on(
      table.printAssetId,
      table.printAssetSha256,
    ),
    index("printify_media_copies_status_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
);

export const printifyProductionProducts = sqliteTable(
  "printify_production_products",
  {
    id: text("id").primaryKey(),
    configuredProductId: text("configured_product_id").notNull()
      .references(() => products.id),
    designRevisionId: text("design_revision_id").notNull()
      .references(() => designRevisions.id),
    baseProductId: text("base_product_id").notNull().references(() => products.id),
    projectionVersion: text("projection_version", {
      enum: ["legacy-shirt-v1", "safe-margin-v1"],
    }).notNull(),
    printGeometryKey: text("print_geometry_key").notNull(),
    printAssetId: text("print_asset_id").notNull().references(() => printAssets.id),
    printAssetSha256: text("print_asset_sha256").notNull(),
    mediaCopyId: text("media_copy_id").notNull()
      .references(() => printifyMediaCopies.id),
    printifyVariantId: integer("printify_variant_id").notNull(),
    blueprintId: integer("blueprint_id").notNull(),
    printProviderId: integer("print_provider_id").notNull(),
    retailPriceMinorUnits: integer("retail_price_minor_units").notNull(),
    providerProductId: text("provider_product_id").unique(),
    providerSku: text("provider_sku").unique(),
    title: text("title").notNull().unique(),
    requestSha256: text("request_sha256").notNull(),
    readbackSha256: text("readback_sha256"),
    status: text("status", {
      enum: [
        "pending", "creating", "verifying", "ready", "ambiguous", "failed",
        "archived",
      ],
    }).notNull().default("pending"),
    leaseId: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("printify_production_products_identity_unique_idx").on(
      table.configuredProductId,
      table.designRevisionId,
      table.baseProductId,
      table.projectionVersion,
      table.printGeometryKey,
      table.printAssetId,
      table.printAssetSha256,
      table.printifyVariantId,
      table.retailPriceMinorUnits,
    ),
    index("printify_production_products_status_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
);

export const printifyFulfilmentOrders = sqliteTable(
  "printify_fulfilment_orders",
  {
    id: text("id").primaryKey(),
    paidOrderId: text("paid_order_id").notNull().unique()
      .references(() => paidOrders.id),
    externalId: text("external_id").notNull().unique(),
    label: text("label").notNull(),
    providerOrderId: text("provider_order_id").unique(),
    requestSha256: text("request_sha256").notNull(),
    readbackSha256: text("readback_sha256"),
    status: text("status", {
      enum: [
        "pending", "creating", "verifying", "on_hold", "submitting",
        "in_production", "ambiguous", "failed", "fulfilled",
      ],
    }).notNull().default("pending"),
    leaseId: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    fulfilledAt: integer("fulfilled_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("printify_fulfilment_orders_status_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
);

export const printifyFulfilmentOrderLines = sqliteTable(
  "printify_fulfilment_order_lines",
  {
    id: text("id").primaryKey(),
    fulfilmentOrderId: text("fulfilment_order_id").notNull()
      .references(() => printifyFulfilmentOrders.id),
    paidOrderLineId: text("paid_order_line_id").notNull().unique()
      .references(() => paidOrderLines.id),
    externalId: text("external_id").notNull().unique(),
    productionProductId: text("production_product_id").notNull()
      .references(() => printifyProductionProducts.id),
    providerProductId: text("provider_product_id").notNull(),
    printifyVariantId: integer("printify_variant_id").notNull(),
    providerSku: text("provider_sku").notNull().unique(),
    quantity: integer("quantity").notNull(),
    shippedQuantity: integer("shipped_quantity").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("printify_fulfilment_order_lines_order_idx").on(
      table.fulfilmentOrderId,
      table.createdAt,
    ),
  ],
);

export const printifyWebhookInbox = sqliteTable(
  "printify_webhook_inbox",
  {
    eventId: text("event_id").primaryKey(),
    topic: text("topic").notNull(),
    providerOrderId: text("provider_order_id").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    status: text("status", {
      enum: ["pending", "processing", "processed", "failed", "ambiguous"],
    }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    processingStartedAt: integer("processing_started_at", {
      mode: "timestamp_ms",
    }),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    index("printify_webhook_inbox_pending_idx").on(
      table.status,
      table.receivedAt,
    ),
  ],
);

export const printifyShipments = sqliteTable(
  "printify_shipments",
  {
    id: text("id").primaryKey(),
    fulfilmentOrderId: text("fulfilment_order_id").notNull()
      .references(() => printifyFulfilmentOrders.id),
    carrier: text("carrier").notNull(),
    trackingNumber: text("tracking_number").notNull(),
    trackingUrl: text("tracking_url").notNull(),
    shippedAt: integer("shipped_at", { mode: "timestamp_ms" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    shopifyFulfilmentId: text("shopify_fulfilment_id").unique(),
    requestSha256: text("request_sha256").notNull(),
    status: text("status", {
      enum: [
        "pending", "creating", "ready", "ambiguous", "failed", "delivered",
      ],
    }).notNull().default("pending"),
    leaseId: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("printify_shipments_order_tracking_batch_unique_idx").on(
      table.fulfilmentOrderId,
      table.trackingNumber,
      table.requestSha256,
    ),
    index("printify_shipments_status_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
);

export const printifyShipmentLines = sqliteTable(
  "printify_shipment_lines",
  {
    shipmentId: text("shipment_id").notNull()
      .references(() => printifyShipments.id),
    fulfilmentOrderLineId: text("fulfilment_order_line_id").notNull()
      .references(() => printifyFulfilmentOrderLines.id),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    uniqueIndex("printify_shipment_lines_order_line_unique_idx").on(table.fulfilmentOrderLineId),
    primaryKey({
      columns: [table.shipmentId, table.fulfilmentOrderLineId],
    }),
  ],
);

export const orderManagementCapabilities = sqliteTable(
  "order_management_capabilities",
  {
    tokenHash: text("token_hash").primaryKey(),
    shopifyCartId: text("shopify_cart_id").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    boundAt: integer("bound_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("order_management_capabilities_expires_idx").on(table.expiresAt),
  ],
);

export const shopifyWebhookInbox = sqliteTable(
  "shopify_webhook_inbox",
  {
    webhookId: text("webhook_id").primaryKey(),
    topic: text("topic").notNull(),
    shopDomain: text("shop_domain").notNull(),
    apiVersion: text("api_version").notNull(),
    triggeredAt: text("triggered_at"),
    payloadSha256: text("payload_sha256").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", {
      enum: ["pending", "processing", "processed", "failed"],
    }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    processingStartedAt: integer("processing_started_at", {
      mode: "timestamp_ms",
    }),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
  },
  (table) => [
    index("shopify_webhook_inbox_pending_idx").on(
      table.status,
      table.receivedAt,
    ),
  ],
);

export const paidOrders = sqliteTable(
  "paid_orders",
  {
    id: text("id").primaryKey(),
    shopifyOrderId: text("shopify_order_id").notNull().unique(),
    shopifyOrderName: text("shopify_order_name").notNull(),
    sourcePayloadSha256: text("source_payload_sha256").notNull(),
    orderManagementCapabilityHash: text("order_management_capability_hash")
      .unique()
      .references(() => orderManagementCapabilities.tokenHash),
    currencyCode: text("currency_code").notNull(),
    totalMinorUnits: integer("total_minor_units").notNull(),
    status: text("status", {
      enum: [
        "production_hold",
        "exception_review",
        "fulfilment_locked",
        "cancelled",
        "refunded",
        "fulfilled",
      ],
    }).notNull(),
    fraudResult: text("fraud_result", {
      enum: ["pending", "accept", "none", "cancel", "investigate"],
    }).notNull().default("pending"),
    addressValidationResult: text("address_validation_result", {
      enum: ["pending", "no_issues", "warning", "error"],
    }).notNull().default("pending"),
    productionHoldExpiresAt: integer("production_hold_expires_at", {
      mode: "timestamp_ms",
    }).notNull(),
    productionLeaseId: text("production_lease_id"),
    productionLeaseExpiresAt: integer("production_lease_expires_at", {
      mode: "timestamp_ms",
    }),
    shopifyOrderUpdatedAt: text("shopify_order_updated_at"),
    deliveryAddressSha256: text("delivery_address_sha256"),
    deliveryAddressJson: text("delivery_address_json"),
    validationCheckedAt: integer("validation_checked_at", {
      mode: "timestamp_ms",
    }),
    fulfilmentLockedAt: integer("fulfilment_locked_at", {
      mode: "timestamp_ms",
    }),
    personalDataPurgedAt: integer("personal_data_purged_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("paid_orders_hold_idx").on(
      table.status,
      table.productionHoldExpiresAt,
    ),
  ],
);

export const personalDataAccessLog = sqliteTable(
  "personal_data_access_log",
  {
    id: text("id").primaryKey(),
    subjectHash: text("subject_hash").notNull(),
    actor: text("actor", {
      enum: [
        "system:shopify-webhook",
        "system:paid-order-reconciliation",
      ],
    }).notNull(),
    action: text("action", { enum: ["receive", "read"] }).notNull(),
    purpose: text("purpose", {
      enum: [
        "paid-order-ingestion",
        "fraud-address-line-validation",
      ],
    }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("personal_data_access_log_subject_idx").on(
      table.subjectHash,
      table.occurredAt,
    ),
    index("personal_data_access_log_occurred_idx").on(table.occurredAt),
  ],
);

export const privacyObjectDeletions = sqliteTable(
  "privacy_object_deletions",
  {
    id: text("id").primaryKey(),
    bucket: text("bucket", { enum: ["design-artwork"] }).notNull(),
    storageKey: text("storage_key").notNull(),
    reason: text("reason", { enum: ["abandoned-draft"] }).notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    enqueuedAt: integer("enqueued_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("privacy_object_deletions_bucket_key_unique_idx").on(
      table.bucket,
      table.storageKey,
    ),
    index("privacy_object_deletions_pending_idx").on(
      table.deletedAt,
      table.enqueuedAt,
    ),
  ],
);

export const paidOrderLines = sqliteTable(
  "paid_order_lines",
  {
    id: text("id").primaryKey(),
    paidOrderId: text("paid_order_id")
      .notNull()
      .references(() => paidOrders.id),
    shopifyLineItemId: text("shopify_line_item_id").notNull(),
    linePosition: integer("line_position").notNull(),
    quantity: integer("quantity").notNull(),
    baseProductId: text("base_product_id")
      .notNull()
      .references(() => products.id),
    configuredProductId: text("configured_product_id")
      .notNull()
      .references(() => products.id),
    designRevisionId: text("design_revision_id")
      .notNull()
      .references(() => designRevisions.id),
    projectionVersion: text("projection_version", {
      enum: ["legacy-shirt-v1", "safe-margin-v1"],
    }).notNull(),
    printGeometryKey: text("print_geometry_key").notNull(),
    printAssetId: text("print_asset_id")
      .notNull()
      .references(() => printAssets.id),
    printAssetSha256: text("print_asset_sha256").notNull(),
    shopifyVariantId: text("shopify_variant_id").notNull(),
    printifyVariantId: integer("printify_variant_id").notNull(),
    variantMappingSnapshotId: text("variant_mapping_snapshot_id").notNull(),
    colour: text("colour", { enum: ["Black", "Cream", "White"] }).notNull(),
    size: text("size").notNull(),
    lineCapabilitySha256: text("line_capability_sha256").notNull(),
    retailPriceMinorUnits: integer("retail_price_minor_units"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("paid_order_lines_shopify_line_unique_idx").on(
      table.paidOrderId,
      table.shopifyLineItemId,
    ),
    uniqueIndex("paid_order_lines_position_unique_idx").on(
      table.paidOrderId,
      table.linePosition,
    ),
    index("paid_order_lines_identity_idx").on(
      table.configuredProductId,
      table.designRevisionId,
      table.printAssetId,
    ),
    check("paid_order_lines_quantity_check", sql`${table.quantity} BETWEEN 1 AND 10`),
  ],
);

export const fulfilmentExceptions = sqliteTable(
  "fulfilment_exceptions",
  {
    id: text("id").primaryKey(),
    paidOrderId: text("paid_order_id")
      .notNull()
      .references(() => paidOrders.id),
    code: text("code").notNull(),
    summary: text("summary").notNull(),
    status: text("status", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("fulfilment_exceptions_open_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

// Command receipts retain no artwork or address data. Product deletion keeps
// these records, along with the paid-order identities they explain.
export const productLifecycleTransitions = sqliteTable("product_lifecycle_transitions", {
  commandId: text("command_id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id),
  fromStatus: text("from_status", { enum: ["active", "suspended", "unpublished"] }).notNull(),
  toStatus: text("to_status", { enum: ["active", "suspended", "unpublished", "retired"] }).notNull(),
  actor: text("actor").notNull(),
  actorId: text("actor_id").notNull(),
  runId: text("run_id").notNull(),
  reason: text("reason").notNull(),
  requestBody: text("request_body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
}, table => [index("product_lifecycle_history_idx").on(table.productId, table.createdAt)]);


export const orderManagementCommands = sqliteTable("order_management_commands", {
  id: text("id").primaryKey(),
  paidOrderId: text("paid_order_id").notNull().references(() => paidOrders.id),
  operation: text("operation", {enum: ["address", "cancel"]}).notNull(),
  requestSha256: text("request_sha256").notNull(),
  status: text("status", {enum: ["pending", "processing", "succeeded", "rejected", "ambiguous"]}).notNull(),
  shopifyJobId: text("shopify_job_id"),
  createdAt: integer("created_at", {mode: "timestamp_ms"}).notNull(),
  updatedAt: integer("updated_at", {mode: "timestamp_ms"}).notNull(),
  completedAt: integer("completed_at", {mode: "timestamp_ms"}),
}, table => [index("order_management_pending_idx").on(table.status, table.updatedAt)]);
export const orderManagementAccessLog = sqliteTable("order_management_access_log", {
  id: text("id").primaryKey(),
  subjectHash: text("subject_hash").notNull(),
  actor: text("actor", {enum: ["customer:capability", "system:order-management"]}).notNull(),
  action: text("action", {enum: ["read", "address", "cancel", "refund-read"]}).notNull(),
  occurredAt: integer("occurred_at", {mode: "timestamp_ms"}).notNull(),
}, table => [index("order_management_access_time_idx").on(table.occurredAt)]);
