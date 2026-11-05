import { DeliveryAddressSchema, orderRequest, orderIdentityMismatchFields, orderReadbackIdentity, type DeliveryAddress } from "./printify-order-identity";
import { Effect, Either, Schema } from "effect";
import { PrintifyOrderDatabaseError, safeD1ErrorDetails } from "./printify-order-diagnostics";

import {
  IntegrationConfigError,
  requirePrintifyConfig,
  type IntegrationEnv,
} from "./integration-config";
import {
  PrintifyProductionClient,
  makePrintifyProductionClientLayer,
  type PrintifyCreateOrderRequest,
  type PrintifyProductionClientShape,
  type PrintifyProductionError,
} from "./printify-production-client";

const MAX_ORDERS_PER_RUN = 100;
const ORDER_LEASE_MS = 2 * 60 * 1_000;
const MAX_IDENTITY_READ_ATTEMPTS = 5;
const IDENTITY_READ_WINDOW_MS = 5 * 60 * 1_000;
const IDENTITY_READ_INTERVAL_MS = 30 * 1_000;
const NonEmptyText = Schema.String.pipe(Schema.minLength(1));
const Sha256 = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const OrderStatus = Schema.Literal(
  "pending",
  "creating",
  "verifying",
  "on_hold",
  "submitting",
  "in_production",
  "ambiguous",
  "failed",
  "fulfilled",
);

const CandidateOrderSchema = Schema.Struct({
  delivery_address_json: NonEmptyText,
  id: Schema.UUID,
  label: NonEmptyText,
  order_id: Schema.NullOr(Schema.UUID),
  provider_order_id: Schema.NullOr(NonEmptyText),
  request_sha256: Schema.NullOr(Sha256),
  status: Schema.NullOr(OrderStatus),
});

type CandidateOrder = Schema.Schema.Type<typeof CandidateOrderSchema>;

const CandidateLineSchema = Schema.Struct({
  print_provider_id: PositiveInt,
  external_id: Schema.UUID,
  paid_order_line_id: Schema.UUID,
  printify_variant_id: PositiveInt,
  production_product_id: Schema.UUID,
  provider_product_id: NonEmptyText,
  provider_sku: NonEmptyText,
  quantity: PositiveInt,
  retail_price_minor_units: PositiveInt,
});

type CandidateLine = Schema.Schema.Type<typeof CandidateLineSchema>;

const StoredOrderSchema = Schema.Struct({
  attempt_count: Schema.Int.pipe(Schema.nonNegative()),
  created_at: Schema.Int,
  id: Schema.UUID,
  lease_expires_at: Schema.NullOr(Schema.Int),
  lease_id: Schema.NullOr(NonEmptyText),
  provider_order_id: Schema.NullOr(NonEmptyText),
  request_sha256: Sha256,
  status: OrderStatus,
});

type StoredOrder = Schema.Schema.Type<typeof StoredOrderSchema>;

interface PrintifyOrderSubmissionEnv extends IntegrationEnv {
  readonly DB: D1Database;
}

export interface PrintifyOrderSubmissionReport {
  readonly candidates: number;
  readonly created: number;
  readonly disabled: boolean;
  readonly exceptions: number;
  readonly submitted: number;
  readonly retried: number;
  readonly verified: number;
}

interface MutableReport {
  candidates: number;
  created: number;
  disabled: boolean;
  exceptions: number;
  submitted: number;
  retried: number;
  verified: number;
}

type SubmissionError = PrintifyOrderDatabaseError | PrintifyProductionError;

export function runScheduledPrintifyOrderSubmission(
  env: PrintifyOrderSubmissionEnv,
  fetcher: typeof fetch = fetch,
  now = () => Date.now(),
): Promise<PrintifyOrderSubmissionReport> {
  try {
    requirePrintifyConfig(env);
  } catch (error) {
    if (error instanceof IntegrationConfigError) {
      return Promise.resolve(emptyReport(true));
    }
    return Promise.reject(error instanceof Error
      ? error
      : new Error("Printify order configuration failed."));
  }
  const program = Effect.gen(function*() {
    const report = emptyReport(false);
    report.exceptions += yield* fenceExpiredLeases(env.DB, now());
    const candidates = yield* readCandidateOrders(env.DB, now());
    report.candidates = candidates.length;
    yield* Effect.forEach(
      candidates,
      (candidate) => submitCandidate(env.DB, candidate, report, now),
      { concurrency: 4, discard: true },
    );
    return report;
  }).pipe(Effect.provide(makePrintifyProductionClientLayer(env, fetcher)));
  return Effect.runPromise(program);
}

function submitCandidate(
  db: D1Database,
  candidate: CandidateOrder,
  report: MutableReport,
  now: () => number,
): Effect.Effect<void, SubmissionError, PrintifyProductionClientShape> {
  return Effect.gen(function*() {
    const lines = yield* readCandidateLines(db, candidate.id);
    if (lines.length === 0) return;
    const address = yield* decodeDeliveryAddress(candidate.delivery_address_json);
    const request = orderRequest(candidate, address, lines);
    const requestSha256 = yield* sha256Json(request);
    const row = yield* ensureOrderRows(
      db,
      candidate,
      lines,
      requestSha256,
      now(),
    );
    if (row.status === "ambiguous" || row.status === "failed" ||
        row.status === "fulfilled") {
      return;
    }
    const client = yield* PrintifyProductionClient;
    const verified = yield* createAndVerifyOrder(
      db,
      candidate,
      lines,
      row,
      request,
      address,
      client,
      report,
      now,
    );
    if (verified?.status !== "on_hold") return;
    yield* submitVerifiedOrder(
      db,
      candidate.id,
      verified,
      client,
      report,
      now,
    );
  });
}

function createAndVerifyOrder(
  db: D1Database,
  candidate: CandidateOrder,
  lines: readonly CandidateLine[],
  row: StoredOrder,
  request: PrintifyCreateOrderRequest,
  address: DeliveryAddress,
  client: PrintifyProductionClientShape,
  report: MutableReport,
  now: () => number,
): Effect.Effect<StoredOrder | undefined, SubmissionError> {
  if (row.status === "on_hold" || row.status === "in_production") {
    return Effect.succeed(row);
  }
  return Effect.gen(function*() {
    const claimedAt = now();
    const leaseId = crypto.randomUUID();
    const nextStatus = row.provider_order_id ? "verifying" : "creating";
    const claimed = yield* claimOrder(
      db,
      row,
      nextStatus,
      leaseId,
      claimedAt,
    );
    if (!claimed) return undefined;
    let providerOrderId = row.provider_order_id;
    if (!providerOrderId) {
      const created = yield* Effect.either(client.createOrder(request));
      if (Either.isLeft(created)) {
        yield* handleOrderFailure(
          db,
          candidate.id,
          row.id,
          leaseId,
          created.left,
          "create",
          report,
          now(),
        );
        return undefined;
      }
      providerOrderId = created.right.id;
      yield* storeProviderOrderId(
        db,
        row.id,
        providerOrderId,
        leaseId,
        now(),
      );
      report.created += 1;
    }
    const readback = yield* Effect.either(client.getOrder(providerOrderId));
    if (Either.isLeft(readback)) {
      yield* handleOrderFailure(
        db,
        candidate.id,
        row.id,
        leaseId,
        readback.left,
        "read",
        report,
        now(),
      );
      return undefined;
    }
    const mismatchFields = orderIdentityMismatchFields(providerOrderId, request, address, lines, readback.right);
    if (mismatchFields.length > 0) {
      const checkedAt = now();
      const retry = row.attempt_count + 1 < MAX_IDENTITY_READ_ATTEMPTS &&
        checkedAt >= row.created_at && checkedAt - row.created_at < IDENTITY_READ_WINDOW_MS;
      const details = { operation: "printify_order_identity", paidOrderId: candidate.id,
        fulfilmentOrderId: row.id, providerOrderId, attempt: row.attempt_count + 1, mismatchFields };
      // Report only fixed field names. Never log provider values or the address.
      if (retry) {
        console.warn("bent.shop Printify order identity will be rechecked", details);
        report.retried += 1;
        yield* resetOrder(db, row.id, leaseId, "verifying", "PRINTIFY_ORDER_MISMATCH", checkedAt);
        return undefined;
      }
      console.error("bent.shop Printify order identity requires reconciliation", details);
      yield* failOrder(
        db,
        candidate.id,
        row.id,
        leaseId,
        "PRINTIFY_ORDER_MISMATCH",
        report,
        checkedAt,
        "failed",
        `The Printify order identity differs at: ${mismatchFields.join(", ")}.`,
      );
      return undefined;
    }
    const readbackSha256 = yield* sha256Json(orderReadbackIdentity(readback.right));
    yield* finalizeVerifiedOrder(
      db,
      row.id,
      leaseId,
      readbackSha256,
      now(),
    );
    report.verified += 1;
    return {
      ...row,
      lease_expires_at: null,
      lease_id: null,
      provider_order_id: providerOrderId,
      status: "on_hold",
    };
  });
}

function submitVerifiedOrder(
  db: D1Database,
  paidOrderId: string,
  row: StoredOrder,
  client: PrintifyProductionClientShape,
  report: MutableReport,
  now: () => number,
): Effect.Effect<void, SubmissionError> {
  if (!row.provider_order_id || row.status !== "on_hold") return Effect.void;
  const providerOrderId = row.provider_order_id;
  return Effect.gen(function*() {
    const leaseId = crypto.randomUUID();
    const claimed = yield* claimOrder(
      db,
      row,
      "submitting",
      leaseId,
      now(),
    );
    if (!claimed) return;
    const submitted = yield* Effect.either(
      client.sendOrderToProduction(providerOrderId),
    );
    if (Either.isLeft(submitted)) {
      yield* handleOrderFailure(
        db,
        paidOrderId,
        row.id,
        leaseId,
        submitted.left,
        "submit",
        report,
        now(),
      );
      return;
    }
    yield* finalizeSubmittedOrder(db, row.id, leaseId, now());
    report.submitted += 1;
  });
}

function readCandidateOrders(db: D1Database, now: number) {
  return databaseEffect("read Printify order candidates", () => db.prepare(`
    SELECT paid.id, paid.shopify_order_name AS label,
      paid.delivery_address_json,
      fulfilment.id AS order_id, fulfilment.provider_order_id,
      fulfilment.request_sha256, fulfilment.status
    FROM paid_orders AS paid
    LEFT JOIN printify_fulfilment_orders AS fulfilment
      ON fulfilment.paid_order_id = paid.id
    WHERE paid.status = 'fulfilment_locked'
      AND paid.delivery_address_json IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM paid_order_lines line JOIN products configured ON configured.id = line.configured_product_id
        WHERE line.paid_order_id = paid.id AND configured.status IN ('suspended', 'unpublished', 'retired')
      )
      AND NOT EXISTS (
        SELECT 1 FROM fulfilment_exceptions
        WHERE paid_order_id = paid.id AND status = 'open'
      )
      AND NOT EXISTS (
        SELECT 1 FROM paid_order_lines AS line
        WHERE line.paid_order_id = paid.id AND NOT EXISTS (
          SELECT 1 FROM printify_production_products AS product
          WHERE product.configured_product_id = line.configured_product_id
            AND product.design_revision_id = line.design_revision_id
            AND product.base_product_id = line.base_product_id
            AND product.projection_version = line.projection_version
            AND product.print_geometry_key = line.print_geometry_key
            AND product.print_asset_id = line.print_asset_id
            AND product.print_asset_sha256 = line.print_asset_sha256
            AND product.printify_variant_id = line.printify_variant_id
            AND product.retail_price_minor_units = line.retail_price_minor_units
            AND product.status = 'ready'
            AND product.provider_product_id IS NOT NULL
            AND product.provider_sku IS NOT NULL
        )
      )
      AND (fulfilment.id IS NULL OR fulfilment.status IN (
        'pending', 'verifying', 'on_hold'
      ))
      AND (fulfilment.last_error_code IS NULL OR fulfilment.last_error_code != 'PRINTIFY_ORDER_MISMATCH'
        OR fulfilment.updated_at <= ?)
    ORDER BY paid.fulfilment_locked_at, paid.created_at
    LIMIT ?
  `).bind(now - IDENTITY_READ_INTERVAL_MS, MAX_ORDERS_PER_RUN).all()).pipe(
    Effect.flatMap((result) => decodeRows(
      CandidateOrderSchema,
      result.results,
      "decode Printify order candidates",
    )),
  );
}

function readCandidateLines(db: D1Database, paidOrderId: string) {
  return databaseEffect("read Printify order candidate lines", () => db.prepare(`
    SELECT line.id AS paid_order_line_id, line.id AS external_id,
      line.quantity, line.printify_variant_id, line.retail_price_minor_units,
      product.id AS production_product_id, product.provider_product_id,
      product.provider_sku, product.print_provider_id
    FROM paid_order_lines AS line
    JOIN printify_production_products AS product
      ON product.configured_product_id = line.configured_product_id
      AND product.design_revision_id = line.design_revision_id
      AND product.base_product_id = line.base_product_id
      AND product.projection_version = line.projection_version
      AND product.print_geometry_key = line.print_geometry_key
      AND product.print_asset_id = line.print_asset_id
      AND product.print_asset_sha256 = line.print_asset_sha256
      AND product.printify_variant_id = line.printify_variant_id
      AND product.retail_price_minor_units = line.retail_price_minor_units
      AND product.status = 'ready'
      AND product.provider_product_id IS NOT NULL
      AND product.provider_sku IS NOT NULL
    WHERE line.paid_order_id = ?
    ORDER BY line.line_position
  `).bind(paidOrderId).all()).pipe(
    Effect.flatMap((result) => decodeRows(
      CandidateLineSchema,
      result.results,
      "decode Printify order candidate lines",
    )),
  );
}

function ensureOrderRows(
  db: D1Database,
  candidate: CandidateOrder,
  lines: readonly CandidateLine[],
  requestSha256: string,
  now: number,
) {
  const orderId = candidate.order_id ?? crypto.randomUUID();
  const statements = [
    db.prepare(`
      INSERT INTO printify_fulfilment_orders (
        id, paid_order_id, external_id, label, request_sha256, status,
        attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (paid_order_id) DO NOTHING
    `).bind(
      orderId,
      candidate.id,
      candidate.id,
      candidate.label,
      requestSha256,
      now,
      now,
    ),
    ...lines.map((line) => db.prepare(`
      INSERT INTO printify_fulfilment_order_lines (
        id, fulfilment_order_id, paid_order_line_id, external_id,
        production_product_id, provider_product_id, printify_variant_id,
        provider_sku, quantity, shipped_quantity, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT (paid_order_line_id) DO NOTHING
    `).bind(
      crypto.randomUUID(),
      orderId,
      line.paid_order_line_id,
      line.external_id,
      line.production_product_id,
      line.provider_product_id,
      line.printify_variant_id,
      line.provider_sku,
      line.quantity,
      now,
    )),
    db.prepare(`
      SELECT id, provider_order_id, request_sha256, status, lease_id,
        lease_expires_at, attempt_count, created_at
      FROM printify_fulfilment_orders
      WHERE paid_order_id = ?
    `).bind(candidate.id),
  ];
  return databaseEffect("ensure Printify order rows", () => db.batch(statements)).pipe(
    Effect.flatMap((results) => {
      const selected = results.at(-1)?.results[0];
      return decodeOne(StoredOrderSchema, selected, "decode Printify order row");
    }),
    Effect.flatMap((row) => row.request_sha256 === requestSha256
      ? Effect.succeed(row)
      : Effect.fail(new PrintifyOrderDatabaseError({
        operation: "verify immutable Printify order request",
      }))),
  );
}

function claimOrder(
  db: D1Database,
  row: StoredOrder,
  nextStatus: "creating" | "submitting" | "verifying",
  leaseId: string,
  now: number,
) {
  return databaseEffect("claim Printify order", () => db.prepare(`
    UPDATE printify_fulfilment_orders
    SET status = ?, lease_id = ?, lease_expires_at = ?,
      attempt_count = attempt_count + 1, last_error_code = NULL,
      updated_at = ?
    WHERE id = ? AND status = ? AND lease_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM paid_order_lines line JOIN products configured ON configured.id = line.configured_product_id
        WHERE line.paid_order_id = printify_fulfilment_orders.paid_order_id
          AND configured.status IN ('suspended', 'unpublished', 'retired')
      )
      AND NOT EXISTS (
        SELECT 1 FROM fulfilment_exceptions WHERE paid_order_id = printify_fulfilment_orders.paid_order_id AND status = 'open'
      )
  `).bind(
    nextStatus,
    leaseId,
    now + ORDER_LEASE_MS,
    now,
    row.id,
    row.status,
  ).run()).pipe(Effect.map((result) => result.meta.changes === 1));
}

function storeProviderOrderId(
  db: D1Database,
  orderId: string,
  providerOrderId: string,
  leaseId: string,
  now: number,
) {
  return databaseEffect("store Printify order ID", () => db.prepare(`
    UPDATE printify_fulfilment_orders
    SET provider_order_id = ?, status = 'verifying', updated_at = ?
    WHERE id = ? AND lease_id = ? AND status = 'creating'
  `).bind(providerOrderId, now, orderId, leaseId).run()).pipe(
    Effect.flatMap((result) => result.meta.changes === 1
      ? Effect.void
      : Effect.fail(new PrintifyOrderDatabaseError({
        operation: "store Printify order ID fence",
      }))),
  );
}

function finalizeVerifiedOrder(
  db: D1Database,
  orderId: string,
  leaseId: string,
  readbackSha256: string,
  now: number,
) {
  return databaseEffect("finalize verified Printify order", () => db.prepare(`
    UPDATE printify_fulfilment_orders
    SET status = 'on_hold', lease_id = NULL, lease_expires_at = NULL,
      readback_sha256 = ?, verified_at = ?, updated_at = ?,
      last_error_code = NULL
    WHERE id = ? AND lease_id = ? AND status = 'verifying'
      AND provider_order_id IS NOT NULL
  `).bind(readbackSha256, now, now, orderId, leaseId).run()).pipe(
    Effect.flatMap((result) => result.meta.changes === 1
      ? Effect.void
      : Effect.fail(new PrintifyOrderDatabaseError({
        operation: "finalize verified Printify order fence",
      }))),
  );
}

function finalizeSubmittedOrder(
  db: D1Database,
  orderId: string,
  leaseId: string,
  now: number,
) {
  return databaseEffect("finalize submitted Printify order", () => db.prepare(`
    UPDATE printify_fulfilment_orders
    SET status = 'in_production', lease_id = NULL, lease_expires_at = NULL,
      submitted_at = ?, updated_at = ?, last_error_code = NULL
    WHERE id = ? AND lease_id = ? AND status = 'submitting'
  `).bind(now, now, orderId, leaseId).run()).pipe(
    Effect.flatMap((result) => result.meta.changes === 1
      ? Effect.void
      : Effect.fail(new PrintifyOrderDatabaseError({
        operation: "finalize submitted Printify order fence",
      }))),
  );
}

function handleOrderFailure(
  db: D1Database,
  paidOrderId: string,
  orderId: string,
  leaseId: string,
  error: PrintifyProductionError,
  operation: "create" | "read" | "submit",
  report: MutableReport,
  now: number,
) {
  if (error._tag === "PrintifyProductionRateLimitError" ||
      (operation === "read" &&
        error._tag === "PrintifyProductionDependencyError")) {
    report.retried += 1;
    const retryStatus = operation === "read" ? "verifying" : "pending";
    return resetOrder(db, orderId, leaseId, retryStatus, error._tag, now);
  }
  const ambiguous = error._tag === "PrintifyAmbiguousMutationError";
  const code = ambiguous
    ? `PRINTIFY_ORDER_${operation.toUpperCase()}_AMBIGUOUS`
    : `PRINTIFY_ORDER_${operation.toUpperCase()}_FAILED`;
  return failOrder(
    db,
    paidOrderId,
    orderId,
    leaseId,
    code,
    report,
    now,
    ambiguous ? "ambiguous" : "failed",
  );
}

function resetOrder(
  db: D1Database,
  orderId: string,
  leaseId: string,
  status: "pending" | "verifying",
  errorCode: string,
  now: number,
) {
  return databaseEffect("reset Printify order", () => db.prepare(`
    UPDATE printify_fulfilment_orders
    SET status = ?, lease_id = NULL, lease_expires_at = NULL,
      last_error_code = ?, updated_at = ?
    WHERE id = ? AND lease_id = ?
  `).bind(status, errorCode, now, orderId, leaseId).run()).pipe(Effect.asVoid);
}

function failOrder(
  db: D1Database,
  paidOrderId: string,
  orderId: string,
  leaseId: string,
  errorCode: string,
  report: MutableReport,
  now: number,
  status: "ambiguous" | "failed" = "failed",
  summary = "The Printify order requires reconciliation before production.",
) {
  report.exceptions += 1;
  return databaseEffect("fail Printify order", () => db.batch([
    db.prepare(`
      UPDATE printify_fulfilment_orders
      SET status = ?, lease_id = NULL, lease_expires_at = NULL,
        last_error_code = ?, updated_at = ?
      WHERE id = ? AND lease_id = ?
    `).bind(status, errorCode, now, orderId, leaseId),
    db.prepare(`
      INSERT INTO fulfilment_exceptions (
        id, paid_order_id, code, summary, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, 'open', ?, NULL)
      ON CONFLICT (id) DO UPDATE SET summary = excluded.summary,
        status = 'open', resolved_at = NULL
    `).bind(
      `${paidOrderId}:${errorCode}`,
      paidOrderId,
      errorCode,
      summary,
      now,
    ),
  ])).pipe(Effect.asVoid);
}

function fenceExpiredLeases(db: D1Database, now: number) {
  return databaseEffect("fence expired Printify order mutations", () => db.batch([
    db.prepare(`
      INSERT INTO fulfilment_exceptions (
        id, paid_order_id, code, summary, status, created_at, resolved_at
      )
      SELECT paid_order_id || ':PRINTIFY_ORDER_LEASE_EXPIRED', paid_order_id,
        'PRINTIFY_ORDER_LEASE_EXPIRED',
        'The Printify order mutation lease expired with an unknown result.',
        'open', ?, NULL
      FROM printify_fulfilment_orders
      WHERE status IN ('creating', 'submitting') AND lease_expires_at <= ?
      ON CONFLICT (id) DO UPDATE SET summary = excluded.summary,
        status = 'open', resolved_at = NULL
    `).bind(now, now),
    db.prepare(`
      UPDATE printify_fulfilment_orders
      SET status = 'ambiguous', lease_id = NULL, lease_expires_at = NULL,
        last_error_code = 'PRINTIFY_ORDER_LEASE_EXPIRED', updated_at = ?
      WHERE status IN ('creating', 'submitting') AND lease_expires_at <= ?
    `).bind(now, now),
    db.prepare(`
      UPDATE printify_fulfilment_orders
      SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'verifying' AND lease_expires_at <= ?
    `).bind(now, now),
  ])).pipe(Effect.map((results) => results[1]?.meta.changes ?? 0));
}

function decodeDeliveryAddress(json: string) {
  return Effect.try({
    try: (): unknown => {
      const parsed: unknown = JSON.parse(json);
      return parsed;
    },
    catch: () => new PrintifyOrderDatabaseError({
      operation: "parse locked delivery address",
    }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(DeliveryAddressSchema)),
    Effect.mapError((error) => error instanceof PrintifyOrderDatabaseError
      ? error
      : new PrintifyOrderDatabaseError({
        operation: "decode locked delivery address",
      })),
  );
}

function sha256Json(value: unknown) {
  return Effect.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    },
    catch: () => new PrintifyOrderDatabaseError({
      operation: "hash Printify order identity",
    }),
  });
}

function databaseEffect<Success>(
  operation: string,
  run: () => Promise<Success>,
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new PrintifyOrderDatabaseError({ operation, diagnostic: safeD1ErrorDetails(cause) }),
  });
}

function decodeRows<Decoded, Encoded>(
  schema: Schema.Schema<Decoded, Encoded>,
  rows: readonly unknown[],
  operation: string,
) {
  return Effect.forEach(rows, (row) => Schema.decodeUnknown(schema)(row)).pipe(
    Effect.mapError(() => new PrintifyOrderDatabaseError({ operation })),
  );
}

function decodeOne<Decoded, Encoded>(
  schema: Schema.Schema<Decoded, Encoded>,
  row: unknown,
  operation: string,
) {
  return Schema.decodeUnknown(schema)(row).pipe(
    Effect.mapError(() => new PrintifyOrderDatabaseError({ operation })),
  );
}

function emptyReport(disabled: boolean): MutableReport {
  return {
    candidates: 0,
    created: 0,
    disabled,
    exceptions: 0,
    retried: 0,
    submitted: 0,
    verified: 0,
  };
}
