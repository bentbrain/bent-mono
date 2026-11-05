import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect } from "effect";

import { runAppResponse } from "@/lib/runtime";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  const program = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql<Record<string, unknown>>`SELECT 1 AS ready`;
    return Response.json(
      {
        name: "bent-drive-copilot",
        status: "ok",
        mode: "read-only",
        database: "connected",
      },
      { headers: { "cache-control": "no-store" } }
    );
  }).pipe(Effect.withSpan("health.database"));
  return runAppResponse("route.health", program, {
    "http.request.method": request.method,
  });
}
