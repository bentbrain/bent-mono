import { Data, Effect, Schema } from "effect";

const OperationAction = Schema.Literal(
  "pause-sales",
  "read-sales-status",
  "refresh-catalogue",
  "refresh-print-assets",
  "refresh-variant-mapping",
  "resume-sales",
);

const OperationInput = Schema.Struct({
  action: OperationAction,
  configuredProductId: Schema.optional(Schema.UUID),
  operationsSecret: Schema.NonEmptyString,
  reason: Schema.optional(Schema.String),
  serviceSecret: Schema.NonEmptyString,
  workerUrl: Schema.String.pipe(
    Schema.filter((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, { message: () => "workerUrl must be an HTTPS URL" }),
  ),
});

const SalesIntake = Schema.Struct({
  message: Schema.NullOr(Schema.String),
  paused: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});

const RefreshProduct = Schema.Struct({
  baseProductSlug: Schema.Literal("staple-tee", "cotton-tote"),
  variantCount: Schema.Number,
});

const RefreshResult = Schema.Struct({
  products: Schema.Array(RefreshProduct),
});

const PrintAssetRefreshResult = Schema.Struct({
  productsFailed: Schema.Number,
  productsReconciled: Schema.Number,
});

const ApiError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});

export type OperationsResult =
  | Schema.Schema.Type<typeof RefreshResult>
  | Schema.Schema.Type<typeof PrintAssetRefreshResult>
  | Schema.Schema.Type<typeof SalesIntake>;

class OperationsConfigurationError extends Data.TaggedError(
  "OperationsConfigurationError",
)<{ readonly message: string }> {}

class OperationsRequestError extends Data.TaggedError(
  "OperationsRequestError",
)<{ readonly message: string; readonly status: number | undefined }> {}

class OperationsResponseError extends Data.TaggedError(
  "OperationsResponseError",
)<{ readonly message: string }> {}

type OperationsError =
  | OperationsConfigurationError
  | OperationsRequestError
  | OperationsResponseError;

export function runOperationsCommand(
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<OperationsResult> {
  return Effect.runPromise(
    Schema.decodeUnknown(OperationInput)(input).pipe(
      Effect.mapError(() =>
        new OperationsConfigurationError({
          message: "The operations command configuration is invalid.",
        })
      ),
      Effect.flatMap((configuration) =>
        executeOperation(configuration, fetcher)
      ),
    ),
  );
}

function executeOperation(
  configuration: Schema.Schema.Type<typeof OperationInput>,
  fetcher: typeof fetch,
): Effect.Effect<OperationsResult, OperationsError> {
  const baseUrl = configuration.workerUrl.replace(/\/$/, "");
  if (configuration.action === "read-sales-status") {
    return readSalesStatus(baseUrl, configuration.serviceSecret, fetcher);
  }
  if (configuration.action === "pause-sales" ||
      configuration.action === "resume-sales") {
    const reason = configuration.reason?.trim() ?? "";
    if (reason.length === 0 || reason.length > 200) {
      return Effect.fail(new OperationsConfigurationError({
        message: "A reason between 1 and 200 characters is required.",
      }));
    }
    const paused = configuration.action === "pause-sales";
    return requestJson(
      `${baseUrl}/v2/internal/operations/sales-pause`,
      {
        body: JSON.stringify({ paused, reason }),
        headers: {
          "content-type": "application/json",
          "x-bent-shirt-operations-secret": configuration.operationsSecret,
        },
        method: "PUT",
      },
      SalesIntake,
      fetcher,
    ).pipe(
      Effect.flatMap(() =>
        readSalesStatus(baseUrl, configuration.serviceSecret, fetcher)
      ),
      Effect.flatMap((status) => status.paused === paused
        ? Effect.succeed(status)
        : Effect.fail(new OperationsResponseError({
          message: "The sales status did not match the requested state.",
        }))),
    );
  }
  if (configuration.action === "refresh-print-assets") {
    const url = new URL(
      "/v2/internal/operations/print-assets-refresh",
      baseUrl,
    );
    if (configuration.configuredProductId !== undefined) {
      url.searchParams.set(
        "configuredProductId",
        configuration.configuredProductId,
      );
    }
    return requestJson(
      url.href,
      {
        headers: {
          "x-bent-shirt-operations-secret": configuration.operationsSecret,
        },
        method: "POST",
      },
      PrintAssetRefreshResult,
      fetcher,
    );
  }
  const path = configuration.action === "refresh-catalogue"
    ? "/v2/internal/operations/catalogue-refresh"
    : "/v2/internal/operations/variant-mapping-refresh";
  return requestJson(
    `${baseUrl}${path}`,
    {
      headers: {
        "x-bent-shirt-operations-secret": configuration.operationsSecret,
      },
      method: "POST",
    },
    RefreshResult,
    fetcher,
  );
}

function readSalesStatus(
  baseUrl: string,
  serviceSecret: string,
  fetcher: typeof fetch,
) {
  return requestJson(
    `${baseUrl}/v2/internal/sales-intake`,
    {
      headers: {
        "x-forever-tee-service-secret": serviceSecret,
      },
      method: "GET",
    },
    SalesIntake,
    fetcher,
  );
}

function requestJson<Decoded, Encoded>(
  url: string,
  init: RequestInit,
  schema: Schema.Schema<Decoded, Encoded>,
  fetcher: typeof fetch,
): Effect.Effect<Decoded, OperationsRequestError | OperationsResponseError> {
  return Effect.tryPromise({
    try: () => fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    }),
    catch: () => new OperationsRequestError({
      message: "The operations request could not reach the Worker.",
      status: undefined,
    }),
  }).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.json(),
        catch: () => new OperationsResponseError({
          message: "The Worker returned an invalid JSON response.",
        }),
      }).pipe(Effect.map((body) => ({ body, response })))
    ),
    Effect.flatMap(({ body, response }): Effect.Effect<
      Decoded,
      OperationsRequestError | OperationsResponseError
    > => {
      if (!response.ok) {
        return Schema.decodeUnknown(ApiError)(body).pipe(
          Effect.mapError(() => new OperationsRequestError({
            message: `The Worker rejected the operation with HTTP ${String(response.status)}.`,
            status: response.status,
          })),
          Effect.flatMap(({ error }) =>
            Effect.fail(new OperationsRequestError({
              message: `${error.code}: ${error.message}`,
              status: response.status,
            }))
          ),
        );
      }
      return Schema.decodeUnknown(schema)(body).pipe(
        Effect.mapError(() => new OperationsResponseError({
          message: "The Worker returned an unexpected response.",
        })),
      );
    }),
  );
}
