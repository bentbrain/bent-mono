/** Scopes, error bodies and device enrollment for the Fitness API. */
import { z } from "zod";

export const fitnessScopes = {
  /** Read meals, saved meals, bodyweight, runs and training. */
  read: "fitness:read",
  /** Add, change and remove meals, saved meals, bodyweight and runs. */
  write: "fitness:write",
  /** Import Apple Health weigh-ins and runs. Device keys hold only this scope. */
  healthImport: "fitness:health:import",
  /** Exchange a one-time OAuth token for a device key. */
  healthEnroll: "fitness:health:enroll",
} as const;

/** The `kind` claim on API keys issued to the iPhone sync app. */
export const deviceKeyKind = "fitness-ios";

export const apiErrorCodes = [
  "invalid_request",
  "invalid_device_request",
  "too_many_samples",
  "payload_too_large",
  "unauthorized",
  "key_invalid",
  "insufficient_scope",
  "client_not_allowed",
  "not_invited",
  "not_device_key",
  "timezone_changed",
  "import_conflict",
  "device_limit",
  "enrollment_token_used",
  "rate_limited",
  "auth_unavailable",
  "enrollment_unavailable",
  "issuance_pending",
  "issuance_failed",
  "server_error",
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

/** An error reply. `error` is safe to show; `code` is stable for clients. */
export const ApiError = z.object({
  error: z.string(),
  code: z.enum(apiErrorCodes).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/** `409`: a backfill grouped its days in another timezone. */
export const TimezoneChangedError = z.object({
  error: z.string(),
  code: z.literal("timezone_changed"),
  accountTimezone: z.string(),
});
export type TimezoneChangedError = z.infer<typeof TimezoneChangedError>;

/** `POST /api/health/devices`, sent with a one-time OAuth access token. */
export const DeviceEnrollRequest = z.object({
  installationId: z.uuid(),
  deviceName: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, "Use letters, numbers and punctuation."),
});
export type DeviceEnrollRequest = z.infer<typeof DeviceEnrollRequest>;

/**
 * The device key and the account it belongs to. `userId` and `email` are
 * the verified account, for the app to show before it sends Health data.
 */
export const DeviceEnrollResponse = z.object({
  secret: z.string().min(1),
  accountTimezone: z.string(),
  userId: z.string(),
  email: z.string(),
});
export type DeviceEnrollResponse = z.infer<typeof DeviceEnrollResponse>;

/** `GET /api/health/devices/ready` when enrollment is available. */
export const DeviceReadyReply = z.object({ enrollment: z.literal("enabled") });
