/**
 * iPhone sync devices. The app exchanges a one-time Clerk OAuth access token
 * for an import-only API key, and revokes that key when it disconnects.
 *
 * A device key holds only fitness:health:import. It imports weigh-ins and
 * runs, which can revise how earlier Health runs pair with runs entered in
 * Fitness, and its replies carry the account timezone and an outcome for
 * each sample the request sent. It cannot read or change anything else.
 */
import { createHash } from "node:crypto";
import { clerkClient } from "@clerk/tanstack-react-start/server";
import {
  DeviceEnrollRequest,
  deviceKeyKind,
  fitnessScopes,
} from "@bent/fitness-contracts";
import type {
  ApiErrorCode,
  DeviceEnrollResponse,
} from "@bent/fitness-contracts";
import { invitedEmail, verifyBearer } from "./auth";
import {
  configurationReady,
  deviceClientIds,
  deviceEnrollmentEnabled,
  mcpResource,
} from "./config";
import {
  accountTimezone,
  consumeEnrollmentToken,
  enrollmentTableExists,
  withAccountLock,
} from "./store";

const deviceLimits = {
  /** Installations with an active key, counting the one enrolling. */
  installations: 3,
  /** Keys created per owner in any rolling hour, counting the new one. */
  perHour: 5,
  /** Enrollment request bodies. */
  bytes: 4096,
} as const;

const noStore = { "Cache-Control": "no-store" };
function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers: { ...noStore, ...headers } });
}
function failure(
  status: number,
  code: ApiErrorCode,
  error: string,
  headers: HeadersInit = {},
) {
  return json({ error, code }, status, {
    ...(status === 401
      ? { "WWW-Authenticate": `Bearer error="invalid_token"` }
      : {}),
    ...headers,
  });
}
const unavailable = () =>
  failure(
    503,
    "enrollment_unavailable",
    "iPhone sync enrollment is unavailable. Try again later.",
  );
const authUnavailable = () =>
  failure(
    503,
    "auth_unavailable",
    "Account services are unavailable. Try again shortly.",
  );
const issuanceFailed = () =>
  failure(
    503,
    "issuance_failed",
    "The device key could not be issued. Sign in again to retry.",
  );

let tableReady = false;
/** Forgets the enrollment table check, so tests can repeat it. */
export function forgetEnrollmentTable() {
  tableReady = false;
}

/**
 * Whether iPhone sync enrollment is available: FITNESS_DEVICE_ENROLLMENT is
 * `enabled`, FITNESS_DEVICE_CLIENT_IDS lists the app's OAuth clients, Clerk
 * and the MCP resource are configured, and the enrollment table exists. The
 * table check runs once per process after it succeeds.
 */
export async function deviceEnrollmentReady() {
  if (
    !deviceEnrollmentEnabled() ||
    deviceClientIds().size === 0 ||
    !configurationReady() ||
    !mcpResource()
  )
    return false;
  if (tableReady) return true;
  try {
    tableReady = await enrollmentTableExists();
  } catch {
    return false;
  }
  return tableReady;
}

/** GET /api/health/devices/ready: whether the app can enroll. */
export async function handleDeviceReady() {
  return (await deviceEnrollmentReady())
    ? json({ enrollment: "enabled" })
    : unavailable();
}

type DeviceKey = {
  id: string;
  installationId: string | null;
  active: boolean;
  createdAt: number;
};

/** Every iPhone sync key the owner has, including revoked and expired ones. */
async function deviceKeys(owner: string) {
  const keys: DeviceKey[] = [];
  // Clerk may return fewer keys per page than asked for, so the offset moves
  // by what each page held.
  for (let offset = 0, pages = 0; ; pages++) {
    if (pages > 100) throw new Error("The API key list did not end.");
    const page = await clerkClient().apiKeys.list({
      subject: owner,
      includeInvalid: true,
      limit: 100,
      offset,
    });
    for (const key of page.data)
      if (key.claims?.kind === deviceKeyKind)
        keys.push({
          id: key.id,
          installationId:
            typeof key.claims.installationId === "string"
              ? key.claims.installationId
              : null,
          active: !key.revoked && !key.expired,
          createdAt: key.createdAt,
        });
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.totalCount) return keys;
  }
}

async function readBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > deviceLimits.bytes) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength > deviceLimits.bytes
    ? null
    : text;
}

/**
 * POST /api/health/devices: exchanges a one-time OAuth access token from the
 * iPhone sync app for an import-only device key.
 *
 * The token must be a Clerk OAuth access token for the MCP resource with
 * fitness:health:enroll, issued to a client in FITNESS_DEVICE_CLIENT_IDS,
 * for an invited account. Each token enrolls once: its digest is committed
 * before any key changes, so a retry after any later failure needs a new
 * sign-in. Key changes for an owner run one at a time under the account
 * lock. Enrolling an installation revokes its earlier keys, including one
 * left by an enrollment whose reply was lost.
 */
export async function handleDeviceEnroll(request: Request) {
  if (!(await deviceEnrollmentReady())) return unavailable();
  const check = await verifyBearer(request, ["oauth_token"]);
  if (!check.ok) {
    if (check.failure === "unavailable") return authUnavailable();
    if (check.failure === "unconfigured") return unavailable();
    return failure(
      401,
      "unauthorized",
      "Sign in to Fitness from the iPhone app to connect it.",
    );
  }
  const { bearer } = check;
  const userId = bearer.userId;
  if (bearer.tokenType !== "oauth_token" || !userId?.startsWith("user_"))
    return failure(
      401,
      "unauthorized",
      "Sign in to Fitness from the iPhone app to connect it.",
    );
  if (!bearer.scopes.includes(fitnessScopes.healthEnroll))
    return failure(
      403,
      "insufficient_scope",
      "Approve iPhone sync access to connect this device.",
    );
  if (!bearer.clientId || !deviceClientIds().has(bearer.clientId))
    return failure(
      403,
      "client_not_allowed",
      "Connect from the Fitness Sync iPhone app.",
    );
  let email: string | null;
  try {
    email = await invitedEmail(userId);
  } catch {
    return authUnavailable();
  }
  if (!email)
    return failure(
      403,
      "not_invited",
      "This account needs an invitation. Contact the app owner.",
    );

  const text = await readBody(request);
  let parsed: ReturnType<typeof DeviceEnrollRequest.safeParse> | null = null;
  try {
    parsed =
      text === null ? null : DeviceEnrollRequest.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success)
    return failure(
      400,
      "invalid_request",
      "Send the installation ID as a UUID and a device name of up to 60 characters.",
    );
  const installationId = parsed.data.installationId.toLowerCase();
  const deviceName = parsed.data.deviceName;

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.trim().replace(/^Bearer\s+/i, "");
  const digest = createHash("sha256").update(token).digest("hex");
  try {
    if (!(await consumeEnrollmentToken(userId, digest, installationId)))
      return failure(
        409,
        "enrollment_token_used",
        "This sign-in was already used to connect a device. Sign in again.",
      );
  } catch (error) {
    console.error("fitness.devices.token_record_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return issuanceFailed();
  }

  type Issued =
    | { ok: true; secret: string; accountTimezone: string }
    | { ok: false; response: Response };
  let issued: Issued;
  try {
    issued = await withAccountLock(userId, async (sql): Promise<Issued> => {
      const timezone = await accountTimezone(sql, userId);
      const keys = await deviceKeys(userId);
      const hourAgo = Date.now() - 3600_000;
      const recent = keys
        .filter((k) => k.createdAt > hourAgo)
        .map((k) => k.createdAt)
        .sort((a, b) => a - b);
      if (recent.length + 1 > deviceLimits.perHour) {
        const oldest = recent[recent.length - deviceLimits.perHour] ?? hourAgo;
        const wait = Math.max(1, Math.ceil((oldest - hourAgo) / 1000));
        return {
          ok: false,
          response: failure(
            429,
            "rate_limited",
            "Too many devices were connected in the last hour. Try again later.",
            { "Retry-After": String(wait) },
          ),
        };
      }
      const others = new Set(
        keys
          .filter((k) => k.active && k.installationId !== installationId)
          .map((k) => k.installationId ?? k.id),
      );
      if (others.size + 1 > deviceLimits.installations)
        return {
          ok: false,
          response: failure(
            409,
            "device_limit",
            `Up to ${deviceLimits.installations} iPhones can sync. Revoke one under Manage account → API keys, then connect again.`,
          ),
        };
      // Replace this installation's keys, including any a lost reply left.
      for (const key of keys)
        if (key.active && key.installationId === installationId)
          await clerkClient().apiKeys.revoke({
            apiKeyId: key.id,
            revocationReason: "Replaced by a new connection from this iPhone.",
          });
      const created = await clerkClient().apiKeys.create({
        name: `iPhone sync: ${deviceName}`,
        subject: userId,
        description:
          "Imports Apple Health weigh-ins and runs from the Fitness Sync app.",
        scopes: [fitnessScopes.healthImport],
        claims: { kind: deviceKeyKind, installationId },
        createdBy: userId,
      });
      if (!created.secret) throw new Error("Clerk returned no key secret.");
      return { ok: true, secret: created.secret, accountTimezone: timezone };
    });
  } catch (error) {
    console.error("fitness.devices.issuance_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return issuanceFailed();
  }
  if (!issued.ok) return issued.response;
  const reply: DeviceEnrollResponse = {
    secret: issued.secret,
    accountTimezone: issued.accountTimezone,
    userId,
    email,
  };
  return json(reply, 201);
}

/**
 * DELETE /api/health/devices/current: revokes the device key that sends the
 * request. A key Clerk reports as unknown, revoked or expired fails with
 * `401 key_invalid`, which also answers a retry after a lost reply.
 */
export async function handleDeviceRevoke(request: Request) {
  const check = await verifyBearer(request, ["api_key"]);
  if (!check.ok) {
    if (check.failure === "invalid")
      return failure(401, "key_invalid", "This device key is no longer valid.");
    if (check.failure === "unavailable" || check.failure === "unconfigured")
      return authUnavailable();
    return failure(
      401,
      "unauthorized",
      "Send the device key as the bearer token.",
    );
  }
  const { bearer } = check;
  if (
    bearer.tokenType !== "api_key" ||
    !bearer.userId?.startsWith("user_") ||
    bearer.claims?.kind !== deviceKeyKind
  )
    return failure(
      403,
      "not_device_key",
      "Only an iPhone sync key can disconnect itself. Revoke other keys under Manage account → API keys.",
    );
  try {
    await clerkClient().apiKeys.revoke({
      apiKeyId: bearer.id,
      revocationReason: "Disconnected from the iPhone.",
    });
  } catch {
    return authUnavailable();
  }
  return new Response(null, { status: 204, headers: noStore });
}
