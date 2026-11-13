import "@tanstack/react-start/server-only";

import { env } from "@/server/runtime-env";

export const SALES_PAUSE_MESSAGE =
  "Orders are temporarily paused. Please check back soon.";

class SalesIntakePausedError extends Error {}
export class SalesIntakeDependencyError extends Error {}

export async function assertSalesIntakeOpen() {
  const url = new URL(
    "/v2/internal/sales-intake",
    `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/`,
  );
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      headers: {
        "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new SalesIntakeDependencyError(SALES_PAUSE_MESSAGE);
  }
  if (!response.ok) throw new SalesIntakeDependencyError(SALES_PAUSE_MESSAGE);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SalesIntakeDependencyError(SALES_PAUSE_MESSAGE);
  }
  if (!isSalesIntakePayload(payload)) {
    throw new SalesIntakeDependencyError(SALES_PAUSE_MESSAGE);
  }
  if (payload.paused) throw new SalesIntakePausedError(SALES_PAUSE_MESSAGE);
}

function isSalesIntakePayload(value: unknown): value is { paused: boolean } {
  return isRecord(value) && typeof value["paused"] === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
