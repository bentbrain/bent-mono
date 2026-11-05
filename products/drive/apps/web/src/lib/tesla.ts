import { randomUUID } from "node:crypto";

import * as PgClient from "@effect/sql-pg/PgClient";
import { Data, Effect } from "effect";
import { z } from "zod";

import {
  normalizeVehicleState,
  vinSchema,
} from "@bent-build/tesla-contracts";
import type {
  VehicleStatus as TeslaVehicleStatus,
  VehicleSummary as TeslaVehicleSummary,
} from "@bent-build/tesla-contracts";

import { AppConfigService, reveal } from "./config";
import { hashToken, open, seal } from "./crypto";
import {
  getTeslaConnection,
  updateTeslaConnectionTokens,
} from "./db/store";

import type { TeslaConnection } from "./db/store";

const teslaTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

const vehiclesResponseSchema = z.object({
  response: z.array(
    z.object({
      vin: vinSchema,
      display_name: z.string().nullable().optional(),
      state: z.string().optional(),
    })
  ),
});

const vehicleDataResponseSchema = z.object({
  response: z.object({
    vin: vinSchema,
    display_name: z.string().nullable().optional(),
    state: z.string().optional(),
    charge_state: z
      .object({
        battery_level: z.number().optional(),
        battery_range: z.number().optional(),
        charging_state: z.string().optional(),
        charge_limit_soc: z.number().optional(),
      })
      .optional(),
    climate_state: z
      .object({
        inside_temp: z.number().optional(),
        is_climate_on: z.boolean().optional(),
      })
      .optional(),
    vehicle_state: z
      .object({
        locked: z.boolean().optional(),
        sentry_mode: z.boolean().optional(),
      })
      .optional(),
  }),
});

class TeslaRequestError extends Data.TaggedError("TeslaRequestError")<{
  operation: string;
  message: string;
}> {}

class TeslaHttpError extends Data.TaggedError("TeslaHttpError")<{
  operation: string;
  status: number;
}> {}

class TeslaResponseDecodeError extends Data.TaggedError("TeslaResponseDecodeError")<{
  operation: string;
  message: string;
}> {}

class TeslaConnectionNotFoundError extends Data.TaggedError(
  "TeslaConnectionNotFoundError"
)<{
  connectionId: string;
  message: string;
}> {}

class TeslaPersistenceError extends Data.TaggedError("TeslaPersistenceError")<{
  operation: string;
  message: string;
}> {}

class TeslaTokenCryptoError extends Data.TaggedError("TeslaTokenCryptoError")<{
  operation: string;
  message: string;
}> {}

export const exchangeTeslaAuthorizationCode = (code: string) =>
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const token = yield* requestTeslaToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.teslaClientId,
        client_secret: reveal(config.teslaClientSecret),
        code,
        audience: config.teslaFleetApiBaseUrl,
        redirect_uri: config.teslaRedirectUri,
        scope: config.teslaScopes,
      }),
      "authorization_code"
    );
    const connectionId = yield* makeConnectionId;
    const nowEpoch = yield* currentEpochSeconds;
    const accessTokenEncrypted = yield* encryptToken(
      token.access_token,
      reveal(config.tokenEncryptionKey),
      "access_token.encrypt"
    );
    const refreshTokenEncrypted = yield* encryptToken(
      token.refresh_token,
      reveal(config.tokenEncryptionKey),
      "refresh_token.encrypt"
    );
    const connection = {
      id: connectionId,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      tokenVersion: 1,
      scopes: token.scope ?? config.teslaScopes,
      expiresAtEpoch: nowEpoch + token.expires_in,
    } satisfies TeslaConnection;
    return connection;
  }).pipe(
    Effect.annotateSpans({ "tesla.oauth.grant_type": "authorization_code" }),
    Effect.withSpan("tesla.oauth.exchange_authorization_code")
  );

export const listTeslaVehicles = (connectionId: string) =>
  Effect.gen(function* () {
    const body = yield* requestFleetApi(connectionId, "/api/1/vehicles", "vehicles.list");
    const parsed = yield* decodeResponse(vehiclesResponseSchema, body, "vehicles.list");
    return parsed.response.map((vehicle) => ({
      vin: vehicle.vin,
      displayName: vehicle.display_name ?? vehicle.vin,
      state: normalizeVehicleState(vehicle.state),
    } satisfies TeslaVehicleSummary));
  }).pipe(
    Effect.annotateLogs({ connectionId }),
    Effect.annotateSpans({ "tesla.connection_id": connectionId }),
    Effect.withSpan("tesla.vehicles.list")
  );

export const getTeslaVehicleStatus = (connectionId: string, vin: string) =>
  Effect.gen(function* () {
    const body = yield* requestFleetApi(
      connectionId,
      `/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data`,
      "vehicle_data.get"
    );
    const parsed = yield* decodeResponse(vehicleDataResponseSchema, body, "vehicle_data.get");
    const observedAt = yield* Effect.sync(() => new Date().toISOString()).pipe(
      Effect.withSpan("tesla.vehicle_status.timestamp")
    );
    const vehicle = parsed.response;
    return {
      vin: vehicle.vin,
      displayName: vehicle.display_name ?? vehicle.vin,
      state: normalizeVehicleState(vehicle.state),
      batteryLevel: vehicle.charge_state?.battery_level ?? null,
      estimatedRangeKm:
        vehicle.charge_state?.battery_range === undefined
          ? null
          : Math.round(vehicle.charge_state.battery_range * 1.60934),
      chargingState: vehicle.charge_state?.charging_state ?? null,
      chargeLimitPercent: vehicle.charge_state?.charge_limit_soc ?? null,
      locked: vehicle.vehicle_state?.locked ?? null,
      cabinTempC: vehicle.climate_state?.inside_temp ?? null,
      climateOn: vehicle.climate_state?.is_climate_on ?? null,
      sentryMode: vehicle.vehicle_state?.sentry_mode ?? null,
      observedAt,
    } satisfies TeslaVehicleStatus;
  }).pipe(
    Effect.annotateLogs({ connectionId, vinFingerprint: hashToken(vin).slice(0, 16) }),
    Effect.annotateSpans({
      "tesla.connection_id": connectionId,
      "tesla.vehicle_fingerprint": hashToken(vin).slice(0, 16),
    }),
    Effect.withSpan("tesla.vehicle_status.get")
  );

const requestFleetApi = (connectionId: string, path: string, operation: string) =>
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const accessToken = yield* getTeslaAccessToken(connectionId);
    const url = new URL(path, ensureTrailingSlash(config.teslaFleetApiBaseUrl));
    const response = yield* fetchTesla(
      url,
      { headers: { authorization: `Bearer ${accessToken}` } },
      operation
    );
    if (!response.ok) {
      yield* Effect.logWarning("tesla.fleet_api.rejected").pipe(
        Effect.annotateLogs({ operation, status: response.status })
      );
      return yield* Effect.fail(new TeslaHttpError({ operation, status: response.status }));
    }
    return yield* readJsonResponse(response, operation);
  }).pipe(
    Effect.annotateLogs({ connectionId, operation }),
    Effect.annotateSpans({ "tesla.connection_id": connectionId, "tesla.operation": operation }),
    Effect.withSpan("tesla.fleet_api.request")
  );

const getTeslaAccessToken = (connectionId: string) =>
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}, 0))`;
        const connection = yield* getTeslaConnection(connectionId).pipe(
          Effect.mapError(
            (cause) =>
              new TeslaPersistenceError({
                operation: "tesla_connection.get",
                message: causeMessage(cause),
              })
          )
        );
        if (!connection) {
          return yield* Effect.fail(
            new TeslaConnectionNotFoundError({
              connectionId,
              message: "The Tesla connection was not found. Reconnect the app.",
            })
          );
        }
        const nowEpoch = yield* currentEpochSeconds;
        if (connection.expiresAtEpoch > nowEpoch + 60) {
          return yield* decryptToken(
            connection.accessTokenEncrypted,
            reveal(config.tokenEncryptionKey),
            "access_token.decrypt"
          );
        }

        yield* Effect.logInfo("tesla.token.refresh_started").pipe(
          Effect.annotateLogs({ connectionId, tokenVersion: connection.tokenVersion })
        );
        const refreshToken = yield* decryptToken(
          connection.refreshTokenEncrypted,
          reveal(config.tokenEncryptionKey),
          "refresh_token.decrypt"
        );
        const refreshed = yield* requestTeslaToken(
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: config.teslaClientId,
            refresh_token: refreshToken,
          }),
          "refresh_token"
        );
        const accessTokenEncrypted = yield* encryptToken(
          refreshed.access_token,
          reveal(config.tokenEncryptionKey),
          "access_token.encrypt"
        );
        const refreshTokenEncrypted = yield* encryptToken(
          refreshed.refresh_token,
          reveal(config.tokenEncryptionKey),
          "refresh_token.encrypt"
        );
        const updated = yield* updateTeslaConnectionTokens(
          connection.id,
          connection.tokenVersion,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          refreshed.scope ?? connection.scopes,
          nowEpoch + refreshed.expires_in
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TeslaPersistenceError({
                operation: "tesla_connection.rotate_tokens",
                message: causeMessage(cause),
              })
          )
        );
        if (!updated) {
          return yield* Effect.fail(
            new TeslaPersistenceError({
              operation: "tesla_connection.rotate_tokens",
              message: "The serialized Tesla token update did not match its locked row.",
            })
          );
        }
        yield* Effect.logInfo("tesla.token.refresh_completed").pipe(
          Effect.annotateLogs({ connectionId, refreshOutcome: "updated" })
        );
        return refreshed.access_token;
      })
    );
  }).pipe(
    Effect.annotateLogs({ connectionId }),
    Effect.annotateSpans({ "tesla.connection_id": connectionId }),
    Effect.withSpan("tesla.access_token.get")
  );

const requestTeslaToken = (body: URLSearchParams, grantType: string) =>
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const response = yield* fetchTesla(
      config.teslaTokenEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      `oauth.${grantType}`
    );
    const responseBody = yield* readJsonResponse(response, `oauth.${grantType}`);
    if (!response.ok) {
      return yield* Effect.fail(
        new TeslaHttpError({ operation: `oauth.${grantType}`, status: response.status })
      );
    }
    return yield* decodeResponse(
      teslaTokenResponseSchema,
      responseBody,
      `oauth.${grantType}`
    );
  }).pipe(
    Effect.annotateLogs({ grantType }),
    Effect.annotateSpans({ "tesla.oauth.grant_type": grantType }),
    Effect.withSpan("tesla.oauth.token_request")
  );

const fetchTesla = (url: string | URL, init: RequestInit, operation: string) =>
  Effect.tryPromise({
    try: () => fetch(url, init),
    catch: (cause) => new TeslaRequestError({ operation, message: causeMessage(cause) }),
  }).pipe(
    Effect.annotateLogs({ operation }),
    Effect.annotateSpans({ "tesla.operation": operation }),
    Effect.withSpan("tesla.http.fetch")
  );

const readJsonResponse = (response: Response, operation: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new TeslaRequestError({ operation, message: causeMessage(cause) }),
    });
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (cause) =>
        new TeslaResponseDecodeError({ operation, message: causeMessage(cause) }),
    });
  }).pipe(
    Effect.annotateSpans({ "http.response.status_code": response.status }),
    Effect.withSpan("tesla.http.decode_json")
  );

const decodeResponse = <A>(schema: z.ZodType<A>, value: unknown, operation: string) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return Effect.fail(
      new TeslaResponseDecodeError({
        operation,
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      })
    );
  }
  return Effect.succeed(parsed.data);
};

const encryptToken = (value: string, key: string, operation: string) =>
  Effect.try({
    try: () => seal(value, key),
    catch: (cause) => new TeslaTokenCryptoError({ operation, message: causeMessage(cause) }),
  }).pipe(
    Effect.annotateSpans({ "tesla.token.operation": operation }),
    Effect.withSpan("tesla.token.encrypt")
  );

const decryptToken = (value: string, key: string, operation: string) =>
  Effect.try({
    try: () => open(value, key),
    catch: (cause) => new TeslaTokenCryptoError({ operation, message: causeMessage(cause) }),
  }).pipe(
    Effect.annotateSpans({ "tesla.token.operation": operation }),
    Effect.withSpan("tesla.token.decrypt")
  );

const makeConnectionId = Effect.try({
  try: () => randomUUID(),
  catch: (cause) =>
    new TeslaTokenCryptoError({ operation: "connection_id.generate", message: causeMessage(cause) }),
}).pipe(Effect.withSpan("tesla.connection_id.generate"));

const currentEpochSeconds = Effect.sync(() => Math.floor(Date.now() / 1_000)).pipe(
  Effect.withSpan("tesla.clock.epoch_seconds")
);

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
