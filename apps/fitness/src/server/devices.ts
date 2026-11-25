/**
 * iPhone sync devices. The app exchanges a one-time Clerk OAuth access token
 * for an import-only API key, and revokes that key when it disconnects.
 *
 * A device key holds only fitness:health:import. It imports weigh-ins and
 * runs, which can revise how earlier Health runs pair with runs entered in
 * Fitness, and its replies carry the account timezone and an outcome for
 * each sample the request sent. It cannot read or change anything else.
 *
 * Postgres decides which device key may import, and counts the limits.
 * Each enrollment attempt has
 * a row, and the key Clerk creates for it carries the attempt ID in its
 * claims. Only the key ID recorded on an issued, active row can import, and
 * each installation has at most one active row. A key Clerk creates after
 * its request gave up has no such row, so it can never import.
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
import { deviceKeyClaims, invitedEmail, verifyBearer } from "./auth";
import {
  clerkKeysValid,
  configurationReady,
  deviceClientIds,
  deviceEnrollmentEnabled,
  mcpResource,
} from "./config";
import {
  DeviceLeaseBusy,
  accountTimezone,
  activeDevices,
  countEnrollmentAttempt,
  deactivateDeviceKey,
  deactivateInstallation,
  deactivateKeys,
  enrollmentTableReady,
  enrollmentTokenUsed,
  issueEnrollment,
  recentIssuance,
  recordEnrollment,
  settleEnrollment,
  settlePendingEnrollments,
  withDeviceLease,
} from "./store";

const deviceLimits = {
  /** Installations with an active key, counting the one enrolling. */
  installations: 3,
  /** Keys created per owner in any rolling hour, counting the new one. */
  perHour: 5,
  /** Enrollment request bodies. */
  bytes: 4096,
  /** Seconds a client waits before retrying while another enrollment runs. */
  busySeconds: 10,
  /** Every Clerk call in one enrollment finishes within this many ms. */
  deadlineMs: 45_000,
  /** Seconds an issuance lease lasts, well past the deadline. */
  leaseSeconds: 90,
} as const;

/** How long each Clerk call during enrollment may take. */
let clerkTimeoutMs = 10_000;
/** Sets the Clerk call timeout, for tests. */
export function setEnrollmentClerkTimeout(ms: number) {
  clerkTimeoutMs = ms;
}
class ClerkTimeout extends Error {}
/**
 * Waits for a Clerk call for up to the per-call timeout, and no later than
 * `deadline`. The pinned SDK takes no AbortSignal for these calls, so a call
 * that runs out of time keeps running upstream; the deadline, the lease and
 * the attempt limits bound how much such work there can be.
 */
function bounded<T>(call: Promise<T>, deadline: number): Promise<T> {
  const ms = Math.min(clerkTimeoutMs, deadline - Date.now());
  if (ms <= 0) {
    call.catch(() => undefined);
    return Promise.reject(new ClerkTimeout());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClerkTimeout()), ms);
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Enrollment attempts this process accepts before verifying their token,
 * so unauthenticated requests cannot make Clerk fetch signing keys at will.
 * The SDK refetches its signing keys for each token whose key ID it does
 * not know and reports that with the same reason as an outage, so this
 * budget is the bound on those fetches.
 */
const budget = { perMinute: 10, burst: 5, tokens: 5, updated: Date.now() };
/** Sets the enrollment budget and refills it, for tests. */
export function setEnrollmentBudget(perMinute: number, burst: number) {
  Object.assign(budget, {
    perMinute,
    burst,
    tokens: burst,
    updated: Date.now(),
  });
}
/** Takes one attempt from the budget, or returns the seconds until one is free. */
function takeAttempt() {
  const now = Date.now();
  budget.tokens = Math.min(
    budget.burst,
    budget.tokens + ((now - budget.updated) * budget.perMinute) / 60_000,
  );
  budget.updated = now;
  if (budget.tokens >= 1) {
    budget.tokens -= 1;
    return 0;
  }
  return Math.ceil(((1 - budget.tokens) * 60) / budget.perMinute);
}
/**
 * Enrollment attempts all servers accept per one-minute window before any
 * Clerk call, counted in Postgres, since each server has its own budget.
 */
let sharedPerMinute = 20;
/** Sets the shared attempt limit, for tests. */
export function setSharedEnrollmentLimit(perMinute: number) {
  sharedPerMinute = perMinute;
}
/** One enrollment issues keys at a time in this process. */
let issuing = false;

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
const authUnavailable = (headers: HeadersInit = {}) =>
  failure(
    503,
    "auth_unavailable",
    "Account services are unavailable. Try again shortly.",
    headers,
  );
const busy = () =>
  failure(
    503,
    "issuance_pending",
    "Another connection is being set up. Try again shortly.",
    { "Retry-After": String(deviceLimits.busySeconds) },
  );
const rateLimited = (seconds: number) =>
  failure(
    429,
    "rate_limited",
    "Too many connection attempts. Try again shortly.",
    { "Retry-After": String(seconds) },
  );
const tokenUsed = () =>
  failure(
    409,
    "enrollment_token_used",
    "This sign-in was already used to connect a device. Sign in again.",
  );
const issuanceFailed = () =>
  failure(
    503,
    "issuance_failed",
    "The device key could not be issued. Sign in again to retry.",
  );
const signIn = () =>
  failure(
    401,
    "unauthorized",
    "Sign in to Fitness from the iPhone app to connect it.",
  );
const keyInvalid = () =>
  failure(401, "key_invalid", "This device key is no longer valid.");

/**
 * Whether iPhone sync enrollment is available: FITNESS_DEVICE_ENROLLMENT is
 * `enabled`, FITNESS_DEVICE_CLIENT_IDS lists the app's OAuth clients, the
 * Clerk keys are valid, the MCP resource is valid, and the enrollment table
 * is present with the access enrollment needs. Each call checks the table
 * again.
 */
export async function deviceEnrollmentReady(
  sql?: Parameters<typeof enrollmentTableReady>[0],
) {
  if (
    !deviceEnrollmentEnabled() ||
    deviceClientIds().size === 0 ||
    !configurationReady() ||
    !clerkKeysValid() ||
    !mcpResource()
  )
    return false;
  try {
    return await enrollmentTableReady(sql);
  } catch {
    return false;
  }
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

/** Every iPhone sync key the owner has in Clerk, including revoked and expired ones. */
async function deviceKeys(owner: string, deadline: number) {
  const keys: DeviceKey[] = [];
  // Clerk may return fewer keys per page than asked for, so the offset moves
  // by what each page held.
  for (let offset = 0, pages = 0; ; pages++) {
    if (pages > 100) throw new Error("The API key list did not end.");
    const page = await bounded(
      clerkClient().apiKeys.list({
        subject: owner,
        includeInvalid: true,
        limit: 100,
        offset,
      }),
      deadline,
    );
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

/** Revokes a key in Clerk as cleanup. It can no longer import either way. */
async function revokeQuietly(
  apiKeyId: string,
  reason: string,
  deadline = Date.now() + clerkTimeoutMs,
) {
  try {
    await bounded(
      clerkClient().apiKeys.revoke({ apiKeyId, revocationReason: reason }),
      deadline,
    );
  } catch (error) {
    console.error("fitness.devices.revoke_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
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
 * Before any Clerk call, the request takes one attempt from this server's
 * budget and one from the budget all servers share in Postgres. The token
 * must then be a Clerk OAuth access token for the MCP resource with
 * fitness:health:enroll, issued to a client in FITNESS_DEVICE_CLIENT_IDS,
 * for an invited account. Every Clerk call finishes within the enrollment's
 * deadline.
 *
 * One enrollment issues keys at a time per server, and per owner under a
 * lease row that is not waited for; a busy one replies `503
 * issuance_pending`. Under the lease:
 *
 * 1. Earlier pending attempts become ambiguous. Their requests ended
 *    without recording whether Clerk created a key.
 * 2. Clerk lists every key the owner has. An active row whose key Clerk
 *    reports revoked or expired, or no longer lists, stops being active.
 * 3. The limits are checked in Postgres, counting the new key: attempts in
 *    the last hour that created a key or may have, and installations with
 *    an active key.
 * 4. The attempt is recorded, which uses the token and holds its place in
 *    the hourly limit, before any key change.
 * 5. The installation's active key stops importing, then Clerk revokes the
 *    installation's keys and any key without an active row, as cleanup.
 * 6. Clerk creates the key with the attempt ID in its claims, and the row
 *    records its ID and becomes active. A creation without a confirmed
 *    result makes the attempt ambiguous; a key it created cannot import.
 */
export async function handleDeviceEnroll(request: Request) {
  const deadline = Date.now() + deviceLimits.deadlineMs;
  const wait = takeAttempt();
  if (wait > 0) return rateLimited(wait);
  if (!(await deviceEnrollmentReady())) return unavailable();
  try {
    const shared = await countEnrollmentAttempt();
    if (shared.attempts > sharedPerMinute) return rateLimited(shared.wait);
  } catch {
    return unavailable();
  }
  const check = await verifyBearer(request, ["oauth_token"], {
    timeoutMs: Math.max(0, Math.min(clerkTimeoutMs, deadline - Date.now())),
  });
  if (!check.ok) {
    if (check.failure === "unavailable") return authUnavailable();
    if (check.failure === "unconfigured") return unavailable();
    return signIn();
  }
  const { bearer } = check;
  const userId = bearer.userId;
  if (bearer.tokenType !== "oauth_token" || !userId?.startsWith("user_"))
    return signIn();
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
    email = await bounded(invitedEmail(userId), deadline);
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
  const attemptId = crypto.randomUUID();

  if (issuing) return busy();
  issuing = true;
  type Issued =
    | { ok: true; secret: string; accountTimezone: string }
    | { ok: false; response: Response };
  const refuse = (response: Response): Issued => ({ ok: false, response });
  let recorded = false;
  let issued: Issued;
  try {
    issued = await withDeviceLease(
      userId,
      deviceLimits.leaseSeconds,
      async (sql): Promise<Issued> => {
        if (await enrollmentTokenUsed(sql, digest)) return refuse(tokenUsed());
        await settlePendingEnrollments(sql, userId);
        // A complete listing, so a key it leaves out was deleted.
        const keys = await deviceKeys(userId, deadline);
        const listed = new Map(keys.map((k) => [k.id, k]));
        const before = await activeDevices(sql, userId);
        await deactivateKeys(
          sql,
          userId,
          before
            .filter((d) => !listed.get(d.keyId)?.active)
            .map((d) => d.keyId),
        );
        const active = await activeDevices(sql, userId);

        const ages = await recentIssuance(sql, userId);
        if (ages.length + 1 > deviceLimits.perHour) {
          const oldest = ages[ages.length - deviceLimits.perHour] ?? 0;
          return refuse(
            failure(
              429,
              "rate_limited",
              "Too many devices were connected in the last hour. Try again later.",
              { "Retry-After": String(Math.max(1, Math.ceil(3600 - oldest))) },
            ),
          );
        }
        const others = new Set(
          active
            .filter((d) => d.installationId !== installationId)
            .map((d) => d.installationId),
        );
        if (others.size + 1 > deviceLimits.installations)
          return refuse(
            failure(
              409,
              "device_limit",
              `Up to ${deviceLimits.installations} iPhones can sync. Revoke one under Manage account → API keys, then connect again.`,
            ),
          );

        // The token is used from here on, whatever happens next.
        if (
          !(await recordEnrollment(sql, {
            owner: userId,
            digest,
            attemptId,
            installationId,
          }))
        )
          return refuse(tokenUsed());
        recorded = true;
        let timezone: string;
        try {
          timezone = await accountTimezone(sql, userId);
          await deactivateInstallation(sql, userId, installationId);
          // Clean up in Clerk: this installation's keys, and keys that have
          // no active row, such as one a timed-out creation left.
          const kept = new Set(
            active
              .filter((d) => d.installationId !== installationId)
              .map((d) => d.keyId),
          );
          for (const key of keys)
            if (key.active && !kept.has(key.id))
              await revokeQuietly(
                key.id,
                key.installationId === installationId
                  ? "Replaced by a new connection from this iPhone."
                  : "Not the active key for its iPhone.",
                deadline,
              );
        } catch (error) {
          // No key was created for this attempt.
          await settleEnrollment(sql, attemptId, "failed").catch(
            () => undefined,
          );
          throw error;
        }
        let created: Awaited<
          ReturnType<ReturnType<typeof clerkClient>["apiKeys"]["create"]>
        >;
        try {
          created = await bounded(
            clerkClient().apiKeys.create({
              name: `iPhone sync: ${deviceName}`,
              subject: userId,
              description:
                "Imports Apple Health weigh-ins and runs from the Fitness Sync app.",
              scopes: [fitnessScopes.healthImport],
              claims: {
                kind: deviceKeyKind,
                installationId,
                enrollment: attemptId,
              },
              createdBy: userId,
            }),
            deadline,
          );
          if (!created.secret) throw new Error("Clerk returned no key secret.");
        } catch (error) {
          // Clerk may have created the key; it cannot import either way.
          await settleEnrollment(sql, attemptId, "ambiguous").catch(
            () => undefined,
          );
          throw error;
        }
        await issueEnrollment(sql, attemptId, created.id);
        return { ok: true, secret: created.secret, accountTimezone: timezone };
      },
    );
  } catch (error) {
    if (error instanceof DeviceLeaseBusy) return busy();
    console.error("fitness.devices.issuance_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
    // Before the attempt is recorded, the token is unused and can retry.
    return recorded ? issuanceFailed() : authUnavailable();
  } finally {
    issuing = false;
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
 * DELETE /api/health/devices/current: disconnects the device key that sends
 * the request. Its row stops it importing first, then Clerk revokes it.
 * A key that is not its installation's active key fails with
 * `401 key_invalid`, which also answers a retry after a lost reply. This
 * route works whether or not enrollment is enabled.
 */
export async function handleDeviceRevoke(request: Request) {
  const check = await verifyBearer(request, ["api_key"]);
  if (!check.ok) {
    if (check.failure === "invalid") return keyInvalid();
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
  const key = deviceKeyClaims(bearer);
  if (!key) {
    await revokeQuietly(bearer.id, "Not the active key for its iPhone.");
    return keyInvalid();
  }
  let current: boolean;
  try {
    current = await withDeviceLease(
      key.owner,
      deviceLimits.leaseSeconds,
      (sql) => deactivateDeviceKey(sql, key),
    );
  } catch (error) {
    if (error instanceof DeviceLeaseBusy)
      return authUnavailable({
        "Retry-After": String(deviceLimits.busySeconds),
      });
    return authUnavailable();
  }
  await revokeQuietly(
    bearer.id,
    current
      ? "Disconnected from the iPhone."
      : "Not the active key for its iPhone.",
  );
  return current
    ? new Response(null, { status: 204, headers: noStore })
    : keyInvalid();
}
