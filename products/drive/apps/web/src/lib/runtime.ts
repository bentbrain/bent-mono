import * as OtelResource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Cause, Effect, Layer, Logger, ManagedRuntime } from "effect";

import { AppConfigLive, AppConfigService } from "./config";

import type * as SqlClient from "@effect/sql/SqlClient";

const DatabaseFromConfig = Layer.unwrapEffect(
  AppConfigService.pipe(
    Effect.map((config) =>
      PgClient.layer({
        url: config.databaseUrl,
        maxConnections: 2,
        minConnections: 0,
        idleTimeout: "10 seconds",
        connectTimeout: "5 seconds",
        applicationName: "bent-drive-copilot",
        spanAttributes: {
          "db.system.name": "postgresql",
          "service.name": "bent-drive-copilot",
        },
      })
    )
  )
);

const DatabaseLive = DatabaseFromConfig.pipe(Layer.provide(AppConfigLive));
const TelemetryLive = OtelTracer.layerGlobal.pipe(
  Layer.provide(
    OtelResource.layer({
      serviceName: "bent-drive-copilot",
      serviceVersion: "0.3.0",
      attributes: { "deployment.platform": "vercel" },
    })
  )
);

const AppLayer = Layer.mergeAll(AppConfigLive, DatabaseLive, TelemetryLive, Logger.json);

export type AppServices = AppConfigService | PgClient.PgClient | SqlClient.SqlClient;

export const AppRuntime = ManagedRuntime.make(AppLayer);

export function runAppResponse<E>(
  spanName: string,
  effect: Effect.Effect<Response, E, AppServices>,
  annotations: Record<string, string | number | boolean> = {}
): Promise<Response> {
  const observed = effect.pipe(
    Effect.annotateLogs(annotations),
    Effect.annotateSpans(annotations),
    Effect.tapErrorCause((cause) =>
      Effect.logError("request.failed").pipe(
        Effect.annotateLogs({ spanName, cause: Cause.pretty(cause) })
      )
    ),
    Effect.catchAllCause(() =>
      Effect.succeed(
        Response.json(
          {
            error: "server_error",
            error_description: "Bent Drive Copilot could not complete the request.",
          },
          { status: 500, headers: { "cache-control": "no-store" } }
        )
      )
    ),
    Effect.withSpan(spanName, { attributes: annotations })
  );
  return AppRuntime.runPromise(observed);
}

export function runApp<A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> {
  return AppRuntime.runPromise(effect);
}
