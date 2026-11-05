import { PrintifyOrderSchema, type PrintifyOrder, type PrintifyCreateOrderRequest } from "./printify-order-identity";
export { PrintifyCreateOrderRequestSchema } from "./printify-order-identity";
export type { PrintifyCreateOrderRequest } from "./printify-order-identity";
import { PrintifyProductionProductSchema, type PrintifyProductionProduct } from "./printify-product-identity";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { deferProvider, takeProviderToken } from "./provider-admission";

import {
  requirePrintifyConfig,
  type IntegrationEnv,
} from "./integration-config";

const PRINTIFY_V1_BASE_URL = "https://api.printify.com/v1/";
const REQUEST_TIMEOUT_MS = 15_000;
const NonEmptyText = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(512),
);
const ProviderId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
);
const PositiveInt = Schema.Int.pipe(Schema.positive());
const HttpUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }),
);

const PrintifyUploadedImageSchema = Schema.Struct({
  file_name: NonEmptyText,
  height: PositiveInt,
  id: ProviderId,
  mime_type: Schema.Literal("image/png", "image/jpeg", "image/jpg"),
  preview_url: HttpUrl,
  size: PositiveInt,
  upload_time: NonEmptyText,
  width: PositiveInt,
});

export type PrintifyUploadedImage = Schema.Schema.Type<
  typeof PrintifyUploadedImageSchema
>;

export const PrintifyUploadByUrlRequestSchema = Schema.Struct({
  file_name: NonEmptyText,
  url: HttpUrl,
});

type PrintifyUploadByUrlRequest = Schema.Schema.Type<
  typeof PrintifyUploadByUrlRequestSchema
>;

const CreateProductImageSchema = Schema.Struct({
  angle: Schema.Number.pipe(Schema.finite()),
  id: ProviderId,
  scale: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  x: Schema.Number.pipe(Schema.finite()),
  y: Schema.Number.pipe(Schema.finite()),
});

const CreateProductPlaceholderSchema = Schema.Struct({
  images: Schema.Array(CreateProductImageSchema).pipe(Schema.minItems(1)),
  position: NonEmptyText,
});

const CreateProductPrintAreaSchema = Schema.Struct({
  placeholders: Schema.Array(CreateProductPlaceholderSchema).pipe(
    Schema.minItems(1),
  ),
  variant_ids: Schema.Array(PositiveInt).pipe(Schema.minItems(1)),
});

const CreateProductVariantSchema = Schema.Struct({
  id: PositiveInt,
  is_enabled: Schema.Boolean,
  price: PositiveInt,
  sku: NonEmptyText,
});

export const PrintifyCreateProductRequestSchema = Schema.Struct({
  blueprint_id: PositiveInt,
  description: Schema.String.pipe(Schema.maxLength(2_000)),
  print_areas: Schema.Array(CreateProductPrintAreaSchema).pipe(
    Schema.minItems(1),
  ),
  print_provider_id: PositiveInt,
  title: NonEmptyText,
  variants: Schema.Array(CreateProductVariantSchema).pipe(Schema.minItems(1)),
});

export type PrintifyCreateProductRequest = Schema.Schema.Type<
  typeof PrintifyCreateProductRequestSchema
>;

class PrintifyProductionAuthenticationError extends Data.TaggedError(
  "PrintifyProductionAuthenticationError",
)<{ readonly operation: string }> {}

class PrintifyProductionRateLimitError extends Data.TaggedError(
  "PrintifyProductionRateLimitError",
)<{
  readonly operation: string;
  readonly retryAfterSeconds: number | undefined;
}> {}

class PrintifyProductionDependencyError extends Data.TaggedError(
  "PrintifyProductionDependencyError",
)<{ readonly operation: string; readonly status: number | undefined }> {}

class PrintifyProductionContractError extends Data.TaggedError(
  "PrintifyProductionContractError",
)<{ readonly operation: string }> {}

class PrintifyAmbiguousMutationError extends Data.TaggedError(
  "PrintifyAmbiguousMutationError",
)<{ readonly operation: string }> {}

export type PrintifyProductionError =
  | PrintifyProductionAuthenticationError
  | PrintifyProductionRateLimitError
  | PrintifyProductionDependencyError
  | PrintifyProductionContractError
  | PrintifyAmbiguousMutationError;

export interface PrintifyProductionClientShape {
  readonly createOrder: (
    input: PrintifyCreateOrderRequest,
  ) => Effect.Effect<{ readonly id: string }, PrintifyProductionError>;
  readonly createProduct: (
    input: PrintifyCreateProductRequest,
  ) => Effect.Effect<{ readonly id: string }, PrintifyProductionError>;
  readonly getProduct: (
    productId: string,
  ) => Effect.Effect<PrintifyProductionProduct, PrintifyProductionError>;
  readonly getUploadedImage: (
    imageId: string,
  ) => Effect.Effect<PrintifyUploadedImage, PrintifyProductionError>;
  readonly getOrder: (
    orderId: string,
  ) => Effect.Effect<PrintifyOrder, PrintifyProductionError>;
  readonly sendOrderToProduction: (
    orderId: string,
  ) => Effect.Effect<void, PrintifyProductionError>;
  readonly uploadImageByUrl: (
    input: PrintifyUploadByUrlRequest,
  ) => Effect.Effect<PrintifyUploadedImage, PrintifyProductionError>;
}

export const PrintifyProductionClient =
  Context.GenericTag<PrintifyProductionClientShape>(
    "ForeverTee/PrintifyProductionClient",
  );

interface RequestOptions {
  readonly body?: unknown;
  readonly method: "GET" | "POST";
  readonly mutation: boolean;
  readonly operation: string;
  readonly path: string;
  readonly responseBody?: "empty" | "json";
}

export function makePrintifyProductionClientLayer(
  env: IntegrationEnv & { readonly DB?: D1Database },
  fetcher: typeof fetch = fetch,
) {
  const config = requirePrintifyConfig(env);
  const request = makeRequest(config.apiToken, fetcher, env.DB);
  const shopPath = `shops/${encodeURIComponent(config.shopId)}`;
  const client: PrintifyProductionClientShape = {
    createOrder: (input) =>
      request({
        body: input,
        method: "POST",
        mutation: true,
        operation: "create order",
        path: `${shopPath}/orders.json`,
      }).pipe(decodeCreatedId("create order")),
    createProduct: (input) =>
      request({
        body: input,
        method: "POST",
        mutation: true,
        operation: "create product",
        path: `${shopPath}/products.json`,
      }).pipe(decodeCreatedId("create product")),
    getProduct: (productId) =>
      request({
        method: "GET",
        mutation: false,
        operation: "read product",
        path: `${shopPath}/products/${encodeURIComponent(productId)}.json`,
      }).pipe(decodeProduct("read product")),
    getOrder: (orderId) =>
      request({
        method: "GET",
        mutation: false,
        operation: "read order",
        path: `${shopPath}/orders/${encodeURIComponent(orderId)}.json`,
      }).pipe(decodeOrder("read order")),
    getUploadedImage: (imageId) =>
      request({
        method: "GET",
        mutation: false,
        operation: "read uploaded image",
        path: `uploads/${encodeURIComponent(imageId)}.json`,
      }).pipe(decodeImage("read uploaded image")),
    uploadImageByUrl: (input) =>
      request({
        body: input,
        method: "POST",
        mutation: true,
        operation: "upload image",
        path: "uploads/images.json",
      }).pipe(decodeImage("upload image")),
    sendOrderToProduction: (orderId) =>
      request({
        method: "POST",
        mutation: true,
        operation: "send order to production",
        path: `${shopPath}/orders/${encodeURIComponent(orderId)}/send_to_production.json`,
        responseBody: "empty",
      }).pipe(Effect.asVoid),
  };
  return Layer.succeed(PrintifyProductionClient, client);
}

// A create response acknowledges identity, not readiness. Callers persist the
// ID and must perform a full GET/readback before allowing any production work.
function decodeCreatedId(operation: string) {
  return (effect: Effect.Effect<unknown, PrintifyProductionError>) => effect.pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ id: ProviderId }))),
    Effect.mapError(error => isPrintifyProductionError(error) && error._tag !== "PrintifyProductionContractError"
      ? error
      : new PrintifyAmbiguousMutationError({ operation })),
  );
}

function decodeOrder(operation: string) {
  return (effect: Effect.Effect<unknown, PrintifyProductionError>) =>
    effect.pipe(
      Effect.flatMap(Schema.decodeUnknown(PrintifyOrderSchema)),
      Effect.mapError((error) =>
        isPrintifyProductionError(error)
          ? error
          : new PrintifyProductionContractError({ operation })
      ),
    );
}

function decodeImage(operation: string) {
  return (effect: Effect.Effect<unknown, PrintifyProductionError>) =>
    effect.pipe(
      Effect.flatMap(Schema.decodeUnknown(PrintifyUploadedImageSchema)),
      Effect.mapError((error) =>
        isPrintifyProductionError(error)
          ? error
          : new PrintifyProductionContractError({ operation })
      ),
    );
}

function decodeProduct(operation: string) {
  return (effect: Effect.Effect<unknown, PrintifyProductionError>) =>
    effect.pipe(
      Effect.flatMap(Schema.decodeUnknown(PrintifyProductionProductSchema)),
      Effect.mapError((error) =>
        isPrintifyProductionError(error)
          ? error
          : new PrintifyProductionContractError({ operation })
      ),
    );
}

function makeRequest(apiToken: string, fetcher: typeof fetch, db?: D1Database) {
  return (options: RequestOptions): Effect.Effect<
    unknown,
    PrintifyProductionError
  > =>
    admitPrintifyRequest(db, options.operation).pipe(Effect.flatMap(() => Effect.tryPromise({
      try: () => {
        const headers = new Headers({
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`,
          "User-Agent": "bent.shop",
        });
        if (options.body !== undefined) {
          headers.set("Content-Type", "application/json;charset=utf-8");
        }
        const requestUrl = new URL(options.path, PRINTIFY_V1_BASE_URL);
        return options.body === undefined
          ? fetcher(requestUrl, {
            headers,
            method: options.method,
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          : fetcher(requestUrl, {
            body: JSON.stringify(options.body),
            headers,
            method: options.method,
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
      },
      catch: () => options.mutation
        ? new PrintifyAmbiguousMutationError({
          operation: options.operation,
        })
        : new PrintifyProductionDependencyError({
          operation: options.operation,
          status: undefined,
        }),
    }))).pipe(
      Effect.tap(response => response.status === 429 && db
        ? Effect.tryPromise({
          try: () => deferProvider(db, retryAfterSeconds(response.headers.get("retry-after")) ?? 60),
          catch: () => new PrintifyProductionRateLimitError({ operation: options.operation, retryAfterSeconds: 60 }),
        }) : Effect.void),
      Effect.flatMap((response) => responseEffect(response, options)),
    );
}

function admitPrintifyRequest(db: D1Database | undefined, operation: string): Effect.Effect<void, PrintifyProductionRateLimitError> {
  if (!db) return Effect.void;
  return Effect.gen(function*() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const admission = yield* Effect.tryPromise({
        try: () => takeProviderToken(db, "printify"),
        catch: () => new PrintifyProductionRateLimitError({ operation, retryAfterSeconds: 60 }),
      });
      if (admission.allowed) return;
      if (admission.retryAfterSeconds > 1 || attempt === 2) {
        return yield* Effect.fail(new PrintifyProductionRateLimitError({ operation,
          retryAfterSeconds: admission.retryAfterSeconds }));
      }
      yield* Effect.sleep(1000);
    }
  });
}

function responseEffect(
  response: Response,
  options: RequestOptions,
): Effect.Effect<unknown, PrintifyProductionError> {
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(new PrintifyProductionAuthenticationError({
      operation: options.operation,
    }));
  }
  if (response.status === 429) {
    return Effect.fail(new PrintifyProductionRateLimitError({
      operation: options.operation,
      retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
    }));
  }
  if (!response.ok) {
    if (options.mutation && response.status >= 500) {
      return Effect.fail(new PrintifyAmbiguousMutationError({
        operation: options.operation,
      }));
    }
    return Effect.fail(new PrintifyProductionDependencyError({
      operation: options.operation,
      status: response.status,
    }));
  }
  if (options.responseBody === "empty") return Effect.succeed(undefined);
  return Effect.tryPromise({
    try: () => response.json(),
    catch: () => new PrintifyProductionContractError({
      operation: options.operation,
    }),
  });
}

function retryAfterSeconds(value: string | null) {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function isPrintifyProductionError(
  value: unknown,
): value is PrintifyProductionError {
  if (typeof value !== "object" || value === null || !("_tag" in value)) {
    return false;
  }
  switch (value._tag) {
    case "PrintifyProductionAuthenticationError":
    case "PrintifyProductionRateLimitError":
    case "PrintifyProductionDependencyError":
    case "PrintifyProductionContractError":
    case "PrintifyAmbiguousMutationError":
      return true;
    default:
      return false;
  }
}
