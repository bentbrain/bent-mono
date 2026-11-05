import { Either, Schema } from "effect";
import { recoverPaidOrderProduct, ORDER_1003_PRODUCT_TARGET } from "./paid-order-product-recovery";
import { recoverPaidOrderProvider, ORDER_1003_PROVIDER_TARGET, ORDER_1004_PROVIDER_TARGET } from "./paid-order-provider-recovery";
import { recoverPaidOrderValidation, type PaidOrderHoldEnv } from "./paid-order-holds";
import { verifyOperationsIdentity, type OperationsIdentityEnv } from "./operations-identity";
import { isAuthenticatedOperationsRequest } from "./service-auth";

export const PAID_ORDER_PRODUCT_RECOVERY_PATH = "/v2/internal/operations/paid-order-product-recovery";
export const PAID_ORDER_PROVIDER_RECOVERY_PATH = "/v2/internal/operations/paid-order-provider-recovery";
export const PAID_ORDER_RECOVERY_PATH = "/v2/internal/operations/paid-order-validation-recovery";
const Input = Schema.Union(
  Schema.Struct({ operation: Schema.Literal("plan"), orderId: Schema.UUID,
    expectedSource: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/)) }),
  Schema.Struct({ operation: Schema.Literal("apply"), orderId: Schema.UUID,
    expectedSource: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/)),
    expectedPlanSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)) }),
);
type RecoveryEnv = PaidOrderHoldEnv & OperationsIdentityEnv & {
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
  readonly STORY_VIDEO_RELEASE_ID?: string;
  readonly STORY_VIDEO_RELEASE_COMMIT?: string;
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handlePaidOrderRecoveryRequest(
  request: Request,
  env: RecoveryEnv,
  authenticate = verifyOperationsIdentity,
  fetcher: typeof fetch = fetch,
  now = () => Date.now(),
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const productRecovery = path === PAID_ORDER_PRODUCT_RECOVERY_PATH;
  const providerRecovery = path === PAID_ORDER_PROVIDER_RECOVERY_PATH;
  if (path !== PAID_ORDER_RECOVERY_PATH && !productRecovery && !providerRecovery) return undefined;
  if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  if (!await isAuthenticatedOperationsRequest(request, env)) return json({ code: "UNAUTHORIZED" }, 401);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ code: "JSON_REQUIRED" }, 415);
  const body = await request.text();
  if (body.length > 1_000) return json({ code: "INVALID_REQUEST" }, 400);
  const identity = await authenticate(request, env, body);
  if (!identity?.owner) return json({ code: "OWNER_WORKFLOW_REQUIRED" }, 403);
  let value: unknown;
  try { value = JSON.parse(body); } catch { return json({ code: "INVALID_REQUEST" }, 400); }
  const parsed = Schema.decodeUnknownEither(Input)(value, { onExcessProperty: "error" });
  if (Either.isLeft(parsed)) return json({ code: "INVALID_REQUEST" }, 400);
  const input = parsed.right;
  if (productRecovery && (env.OPERATIONS_ENVIRONMENT !== "production" ||
      input.orderId !== ORDER_1003_PRODUCT_TARGET.orderId)) return json({ code: "EXACT_PRODUCT_RECOVERY_REQUIRED" }, 400);
  const providerTarget = input.orderId === ORDER_1004_PROVIDER_TARGET.orderId
    ? ORDER_1004_PROVIDER_TARGET : ORDER_1003_PROVIDER_TARGET;
  if (providerRecovery && (env.OPERATIONS_ENVIRONMENT !== "production" ||
      input.orderId !== providerTarget.orderId)) return json({ code: "EXACT_PROVIDER_RECOVERY_REQUIRED" }, 400);
  try {
    if (input.expectedSource !== env.STORY_VIDEO_RELEASE_COMMIT ||
        !/^native-\d+$/.test(env.STORY_VIDEO_RELEASE_ID ?? "")) return json({ code: "RECOVERY_SOURCE_MISMATCH" }, 409);
    const verified = await env.DB.prepare(`
      SELECT 1 FROM native_video_release_control control
      JOIN native_video_release_events event ON event.release_id = control.current_release_id
        AND event.stage = 'verified' AND json_extract(event.payload, '$.sourceCommit') = ?
      WHERE control.singleton = 1 AND control.paused = 0 AND control.current_release_id = ?
    `).bind(input.expectedSource, env.STORY_VIDEO_RELEASE_ID).first();
    if (!verified) return json({ code: "VERIFIED_RELEASE_REQUIRED" }, 409);
    const hash = input.operation === "apply" ? input.expectedPlanSha256 : undefined;
    const result = productRecovery
      ? await recoverPaidOrderProduct(env, ORDER_1003_PRODUCT_TARGET, env.STORY_VIDEO_RELEASE_ID ?? "", hash, fetcher, now)
      : providerRecovery
      ? await recoverPaidOrderProvider(env, providerTarget, env.STORY_VIDEO_RELEASE_ID ?? "", hash, fetcher, now)
      : await recoverPaidOrderValidation(env, input.orderId, hash, fetcher, now);
    return json({ ...result, runId: identity.runId, sourceCommit: input.expectedSource,
      releaseId: env.STORY_VIDEO_RELEASE_ID }, result.ready ? 200 : 409);
  } catch {
    // No provider errors, addresses, capabilities or raw response bodies.
    return json({ code: "RECOVERY_DEPENDENCY_UNAVAILABLE" }, 503);
  }
}
