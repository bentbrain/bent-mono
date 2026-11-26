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
 * Each enrollment attempt has a row, and the key Clerk creates for it
 * carries the attempt ID in its claims. Only the key ID recorded on an
 * issued, active row can import, and each installation has at most one
 * active row. A key Clerk creates after its request gave up has no such
 * row, so it can never import.
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
import {
  clerkNotFound,
  clerkRejected,
  deviceKeyClaims,
  headerToken,
  invitedEmail,
  verifyBearer,
} from "./auth";
import {
  clerkKeysValid,
  configurationReady,
  deviceClientIds,
  deviceEnrollmentEnabled,
  mcpResource,
} from "./config";
import { database } from "./db";
import {
  CommitOutcomeUnknown,
  accountTimezone,
  activeDevices,
  attemptUsable,
  chargeAmbiguousEnrollment,
  claimSequence,
  countEnrollmentAttempt,
  deactivateDeviceKey,
  deactivateKeys,
  deviceKeyActive,
  enrollmentBusy,
  enrollmentTableReady,
  recordEnrollment,
  settleEnrollment,
  swapEnrollment,
  swapOutcome,
  unchargedUnissued,
  unneededKeys,
} from "./store";

const deviceLimits = {
  /** Installations with an active key, counting the one enrolling. */
  installations: 3,
  /** Keys created per owner in any rolling hour, counting the new one. */
  perHour: 5,
  /** Enrollment request bodies. */
  bytes: 4096,
  /** Seconds a client waits before retrying while the account is busy. */
  busySeconds: 10,
  /** Milliseconds a ready result is reused for. */
  readyMs: 30_000,
  /** Milliseconds a not-ready result is reused for, so a migration shows soon. */
  notReadyMs: 5_000,
} as const;

/**
 * Enrollment timing, in milliseconds on the monotonic clock. The database
 * transactions set their own short limits; see the store.
 */
const timing = {
  /** The limit on each Clerk call. */
  clerkMs: 10_000,
  /** The time listing the owner's keys, or revoking unneeded ones, may take. */
  cleanupMs: 10_000,
  /** The time Clerk has to revoke the keys a swap replaced. */
  replacedRevokeMs: 5_000,
  /**
   * The time from recording an attempt until its key's create must end,
   * well inside the grace after which cleanup takes a pending attempt for
   * abandoned.
   */
  attemptMs: 5 * 60_000,
};
const defaultTiming = { ...timing };
/** Sets enrollment timing, or restores the defaults, for tests. */
export function setEnrollmentTiming(changes: Partial<typeof timing> = {}) {
  Object.assign(timing, defaultTiming, changes);
}
class ClerkTimeout extends Error {}
/** A deadline on the monotonic clock. */
function deadlineIn(ms: number) {
  return performance.now() + ms;
}
/**
 * Starts a Clerk call only if the deadline has not passed, then waits for
 * it for up to the per-call limit and no later than the deadline. The
 * pinned SDK takes no AbortSignal for these calls, so a call that runs out
 * of time keeps running upstream. Postgres decides which key may import,
 * so such a late result is harmless.
 */
function bounded<T>(
  call: () => Promise<T>,
  deadline = deadlineIn(timing.clerkMs),
): Promise<T> {
  const ms = Math.min(timing.clerkMs, deadline - performance.now());
  if (ms <= 0) return Promise.reject(new ClerkTimeout());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClerkTimeout()), ms);
  });
  return Promise.race([call(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Requests to the device routes this process accepts before verifying any
 * token, so unauthenticated traffic cannot make Clerk fetch signing keys at
 * will or reach the database often. The SDK refetches its signing keys for
 * each token whose key ID it does not know and reports that with the same
 * reason as an outage, so this budget and the shared one bound those
 * fetches.
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
  failure(503, "issuance_pending", "This account is busy. Try again shortly.", {
    "Retry-After": String(deviceLimits.busySeconds),
  });
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
const stale = () =>
  failure(
    409,
    "stale_enrollment",
    "This iPhone has connected again since. Start a new connection.",
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

let readiness: { ready: boolean; at: number } | null = null;
/** Forgets the cached readiness result, for tests. */
export function forgetEnrollmentReadiness() {
  readiness = null;
}
/**
 * Whether iPhone sync enrollment is available: FITNESS_DEVICE_ENROLLMENT is
 * `enabled`, FITNESS_DEVICE_CLIENT_IDS lists the app's OAuth clients, the
 * Clerk keys are valid, the MCP resource is valid, and the enrollment tables
 * are present with the access enrollment needs. The tables are checked in
 * one query; a ready result is reused for 30 seconds and a not-ready one
 * for 5, so a migration shows soon.
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
  if (sql) return enrollmentTableReady(sql).catch(() => false);
  if (
    readiness &&
    performance.now() - readiness.at <
      (readiness.ready ? deviceLimits.readyMs : deviceLimits.notReadyMs)
  )
    return readiness.ready;
  const ready = await enrollmentTableReady().catch(() => false);
  readiness = { ready, at: performance.now() };
  return ready;
}

/** An OAuth client ID as Clerk issues them. */
const clientIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * GET /api/health/devices/ready: whether the app can enroll. With
 * `?clientId=`, also whether tokens from that OAuth application are
 * accepted, so a release can check the client its build embeds.
 */
export async function handleDeviceReady(
  request?: Request,
  ready: () => Promise<boolean> = () => deviceEnrollmentReady(),
) {
  const wait = takeAttempt();
  if (wait > 0) return rateLimited(wait);
  if (!(await ready())) return unavailable();
  const query = request ? new URL(request.url).searchParams : null;
  const clientId = query?.get("clientId") ?? null;
  if (
    query &&
    (query.getAll("clientId").length > 1 ||
      (clientId !== null && !clientIdPattern.test(clientId)))
  )
    return failure(
      400,
      "invalid_request",
      "Send at most one clientId, of up to 128 letters, digits, hyphens or underscores.",
    );
  if (clientId !== null && !deviceClientIds().has(clientId))
    return failure(
      403,
      "client_not_allowed",
      "This OAuth client is not listed in FITNESS_DEVICE_CLIENT_IDS.",
    );
  return json({ enrollment: "enabled" });
}

type DeviceKey = {
  id: string;
  installationId: string | null;
  enrollment: string | null;
  active: boolean;
  createdAt: number;
};

/**
 * The owner's iPhone sync keys in Clerk, including revoked and expired ones.
 * Offset paging can skip keys while the list changes, so this is used only
 * to clean up; it never decides that a key is gone.
 */
async function deviceKeys(owner: string, deadline: number) {
  const keys: DeviceKey[] = [];
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  // Clerk may return fewer keys per page than asked for, so the offset moves
  // by what each page held.
  for (let offset = 0, pages = 0; ; pages++) {
    if (pages > 100) throw new Error("The API key list did not end.");
    const page = await bounded(
      () =>
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
          installationId: text(key.claims.installationId),
          enrollment: text(key.claims.enrollment),
          active: !key.revoked && !key.expired,
          createdAt: key.createdAt,
        });
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.totalCount) return keys;
  }
}

/** Clerk could not say whether an active key still exists. */
class KeyCheckInconclusive extends Error {}

/**
 * Whether Clerk confirms this key can no longer be used: it is revoked or
 * expired, or Clerk reports it does not exist. Any other answer, including
 * a 404 without Clerk's not-found error, is inconclusive and throws
 * KeyCheckInconclusive.
 */
async function keyGone(keyId: string) {
  try {
    const key = await bounded(() => clerkClient().apiKeys.get(keyId));
    return key.revoked || key.expired;
  } catch (error) {
    if (clerkNotFound(error)) return true;
    throw new KeyCheckInconclusive();
  }
}

/** Revokes a key in Clerk as cleanup. It can no longer import either way. */
async function revokeQuietly(
  apiKeyId: string,
  reason: string,
  deadline = deadlineIn(timing.clerkMs),
) {
  try {
    await bounded(
      () =>
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

function logged(event: string, error: unknown) {
  console.error(event, {
    name: error instanceof Error ? error.name : typeof error,
  });
}

/**
 * POST /api/health/devices: exchanges a one-time OAuth access token from the
 * iPhone sync app for an import-only device key.
 *
 * Checks run cheapest first: this server's budget, readiness (reused for
 * 30 seconds), then the budget all servers share in Postgres, before any
 * Clerk call. The token must then be a Clerk OAuth access token for the MCP
 * resource with fitness:health:enroll, issued to a client in
 * FITNESS_DEVICE_CLIENT_IDS, for an invited account. Each Clerk call has up
 * to `clerkMs`.
 *
 * Postgres decides which key may import, so enrollments for one account
 * may run at the same time. Each database change is one short transaction
 * that locks the account row first, as an import does, and each statement
 * and lock wait in it is limited:
 *
 * 1. The app's `enrollmentSequence` is claimed for the installation in its
 *    own short transaction. A sequence no higher than one the
 *    installation already sent is refused with `409 stale_enrollment`.
 *    The claim stays even if a later check refuses the request, and the
 *    token is untouched; a busy account replies `503 issuance_pending`.
 * 2. Clerk is asked about each active key on its own. One it confirms
 *    revoked, expired or deleted stops being active. Any other answer
 *    fails the enrollment with `503 auth_unavailable` and changes nothing.
 * 3. Clerk's key list, within `cleanupMs`, finds keys left by attempts
 *    that issued none, ambiguous or failed, which then count toward the
 *    hourly limit from their creation, and keys to clean up. A key missing from the list is never
 *    treated as gone, and a list that fails or runs out of time is
 *    skipped.
 * 4. The attempt is recorded, which uses the token and reserves its place
 *    in the hourly limit. Under the account lock, the same transaction
 *    refuses a used token with `409 enrollment_token_used`; an attempt
 *    whose installation's app has sent a higher sequence since with `409
 *    stale_enrollment`; a full hourly limit with `429
 *    rate_limited`; and an installation over the limit with `409
 *    device_limit`, counting this attempt each time. Other installations
 *    count while they have an active key or an attempt still being issued,
 *    so overlapping attempts for new installations cannot pass the limit
 *    together. A refusal, or a transaction that times out waiting, changes
 *    nothing and leaves the token unused; a timeout replies `503
 *    issuance_pending`.
 * 5. Attempts still pending after the grace were abandoned and become
 *    ambiguous, so they can never be activated. Clerk then revokes keys no
 *    enrollment needs: keys without an active row, except one an attempt
 *    still pending may yet swap in. Active keys, this installation's
 *    included, keep importing.
 * 6. Just before the create, the attempt must still be pending within the
 *    grace, and the create must end within `attemptMs` of recording, so a
 *    request that paused for long creates nothing and replies `503
 *    issuance_failed`. Clerk creates the key with the attempt ID in its
 *    claims. From then
 *    on, every change to the attempt charges it from the key's creation,
 *    so it keeps counting toward the hourly limit whatever becomes of it.
 *    A create that Clerk's Backend API rejects as an invalid request, with
 *    a documented code for its status (see `clerkRejected`), marks the
 *    attempt failed; any other failure, a gateway's 4xx included, marks it
 *    ambiguous, still counting toward the hourly limit for up to 24 hours,
 *    since Clerk may have made the key. The reply is `503
 *    issuance_failed`, and a key Clerk made for the attempt cannot import.
 * 7. One transaction locks the installation's rows, stops its current key
 *    and makes the new one active, charged from the key's creation, if the
 *    attempt is still pending from within the grace by the database clock
 *    and activating it keeps the installations with active keys within the
 *    limit. An attempt that aged past the grace is never activated; it
 *    becomes ambiguous and keeps its charge. Nor is one while another
 *    attempt for the installation with the same or a higher
 *    `enrollmentSequence` has its key or is still being issued, or once
 *    the app has sent a higher sequence at all: the current key stays, and
 *    this attempt fails, keeping its charge. After the swap commits, Clerk
 *    revokes the replaced key within `replacedRevokeMs`; a revoke that
 *    fails is logged, and a later enrollment's cleanup revokes the key,
 *    which can no longer import. If the swap does not happen, the current
 *    key keeps importing, the new key is revoked, and the reply is `503
 *    issuance_failed`. If the swap's commit reply is lost, its rows are
 *    read again on another connection, waiting for a commit still in
 *    progress. A committed swap's replaced keys are the ones it recorded on
 *    the attempt's row, and when that read cannot tell, both keys are left
 *    for a later enrollment.
 * 8. Before replying `201`, the attempt must still be the installation's
 *    active one. A later enrollment that replaced it meanwhile makes this
 *    request reply `503 issuance_failed`. This check is best effort: when
 *    its read fails, the key is returned. The app keeps the successful
 *    reply with the highest sequence it has received, so a later attempt's
 *    success takes this key's place.
 */
export async function handleDeviceEnroll(request: Request) {
  const wait = takeAttempt();
  if (wait > 0) return rateLimited(wait);
  if (!(await deviceEnrollmentReady())) return unavailable();
  try {
    const shared = await countEnrollmentAttempt(sharedPerMinute);
    if (!shared.allowed) return rateLimited(shared.wait);
  } catch {
    return unavailable();
  }
  const check = await verifyBearer(request, ["oauth_token"], {
    timeoutMs: timing.clerkMs,
  });
  if (!check.ok) {
    if (check.failure === "unavailable") return authUnavailable();
    if (check.failure === "unconfigured") return unavailable();
    return signIn();
  }
  const { bearer } = check;
  const userId = bearer.userId;
  // Clerk's verified ID for the token, its jti for a JWT, identifies it
  // however its string is encoded, so it is what an enrollment uses up.
  const tokenId = bearer.id;
  if (
    bearer.tokenType !== "oauth_token" ||
    !userId?.startsWith("user_") ||
    !tokenId
  )
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
      "Use a token from an OAuth client listed in FITNESS_DEVICE_CLIENT_IDS.",
    );
  let email: string | null;
  try {
    email = await bounded(() => invitedEmail(userId));
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
      "Send the installation ID as a UUID, a device name of up to 60 characters and a positive whole enrollment sequence.",
    );
  const installationId = parsed.data.installationId.toLowerCase();
  const deviceName = parsed.data.deviceName;
  const enrollmentSequence = parsed.data.enrollmentSequence;

  // The app's sequence is claimed first, before any limit or the token: a
  // sequence the installation has already sent is refused, and the claim
  // stays even if the rest of the request is refused.
  try {
    if (!(await claimSequence(userId, installationId, enrollmentSequence)))
      return stale();
  } catch (error) {
    // The token is unused either way; the app tries again with a new
    // sequence.
    if (enrollmentBusy(error) || error instanceof CommitOutcomeUnknown)
      return busy();
    logged("fitness.devices.issuance_failed", error);
    return authUnavailable();
  }

  const token = headerToken(request) ?? "";
  const digest = createHash("sha256").update(token).digest("hex");
  const attemptId = crypto.randomUUID();

  // Until the attempt is recorded, the token is unused and can retry.
  let timezone: string;
  let keys: DeviceKey[] = [];
  try {
    timezone = await accountTimezone(database(), userId);
    // Each active key on its own, so a changing list cannot hide one.
    const gone: string[] = [];
    for (const device of await activeDevices(userId))
      if (await keyGone(device.keyId)) gone.push(device.keyId);
    await deactivateKeys(userId, gone);
    const cleanup = deadlineIn(timing.cleanupMs);
    try {
      keys = await deviceKeys(userId, cleanup);
    } catch (error) {
      logged("fitness.devices.list_failed", error);
    }
    const ambiguous = new Set(await unchargedUnissued(userId));
    for (const key of keys)
      if (key.enrollment && ambiguous.has(key.enrollment))
        await chargeAmbiguousEnrollment(
          userId,
          key.enrollment,
          new Date(key.createdAt),
        );
  } catch (error) {
    if (!(error instanceof KeyCheckInconclusive))
      logged("fitness.devices.issuance_failed", error);
    return authUnavailable();
  }

  let refusal: Awaited<ReturnType<typeof recordEnrollment>>;
  try {
    refusal = await recordEnrollment(
      userId,
      { tokenId, digest, attemptId, installationId, enrollmentSequence },
      deviceLimits,
    );
  } catch (error) {
    logged("fitness.devices.issuance_failed", error);
    // A recording whose commit reply was lost may have used the token.
    return error instanceof CommitOutcomeUnknown
      ? issuanceFailed()
      : authUnavailable();
  }
  if (refusal?.reason === "token_used") return tokenUsed();
  if (refusal?.reason === "stale") return stale();
  if (refusal?.reason === "busy") return busy();
  if (refusal?.reason === "rate_limited")
    return failure(
      429,
      "rate_limited",
      "Too many devices were connected in the last hour. Try again later.",
      { "Retry-After": String(refusal.retryAfter) },
    );
  if (refusal?.reason === "device_limit")
    return failure(
      409,
      "device_limit",
      `Up to ${deviceLimits.installations} iPhones can sync. Revoke one under Manage account → API keys, then connect again.`,
    );

  const createBy = deadlineIn(timing.attemptMs);

  // Clean up in Clerk: keys no current enrollment needs, such as one a
  // timed-out creation left. Cleanup never stops the enrollment.
  try {
    const cleanup = deadlineIn(timing.cleanupMs);
    for (const keyId of await unneededKeys(
      userId,
      keys.filter((k) => k.active),
    ))
      await revokeQuietly(keyId, "Not the active key for its iPhone.", cleanup);
  } catch (error) {
    logged("fitness.devices.cleanup_failed", error);
  }

  // A request that paused for long may find its attempt taken for
  // abandoned, and its place in the hourly limit gone, so it creates
  // nothing.
  let usable = false;
  try {
    usable =
      performance.now() < createBy && (await attemptUsable(userId, attemptId));
  } catch (error) {
    logged("fitness.devices.issuance_failed", error);
  }
  if (!usable) {
    await settleEnrollment(userId, attemptId, "failed").catch(() => undefined);
    return issuanceFailed();
  }

  let created: Awaited<
    ReturnType<ReturnType<typeof clerkClient>["apiKeys"]["create"]>
  >;
  try {
    created = await bounded(
      () =>
        clerkClient().apiKeys.create({
          name: `iPhone sync: ${deviceName}`,
          subject: userId,
          description: "Imports Apple Health weigh-ins and runs into Fitness.",
          scopes: [fitnessScopes.healthImport],
          claims: {
            kind: deviceKeyKind,
            installationId,
            enrollment: attemptId,
          },
          createdBy: userId,
        }),
      createBy,
    );
    if (!created.secret) throw new Error("Clerk returned no key secret.");
  } catch (error) {
    logged("fitness.devices.issuance_failed", error);
    // Clerk may have created the key; it cannot import either way.
    await settleEnrollment(
      userId,
      attemptId,
      clerkRejected(error) ? "failed" : "ambiguous",
    ).catch(() => undefined);
    return issuanceFailed();
  }
  // Clerk made the key, so every change to the attempt from here on charges
  // it to the hourly limit from the key's creation.
  const createdAt = new Date(created.createdAt);

  // The swap stops the installation's current key and makes the new one
  // active together. If it does not happen, the current key keeps
  // importing and the new key is revoked.
  let previous: string[] = [];
  let swapped: { activated: boolean; replaced: string[] } = {
    activated: false,
    replaced: [],
  };
  let revokeNew = true;
  try {
    previous = (await activeDevices(userId))
      .filter((d) => d.installationId === installationId)
      .map((d) => d.keyId);
    swapped = await swapEnrollment(
      userId,
      { attemptId, installationId, keyId: created.id, createdAt },
      deviceLimits,
    );
  } catch (error) {
    logged("fitness.devices.swap_failed", error);
    if (error instanceof CommitOutcomeUnknown) {
      // The commit may have landed, or still be landing, in which case the
      // old key is inactive and the new key is the installation's only
      // one. Read the rows again, waiting for the commit, before revoking
      // anything.
      let outcome: Awaited<ReturnType<typeof swapOutcome>> = {
        outcome: "unknown",
        replaced: [],
      };
      try {
        outcome = await swapOutcome({
          owner: userId,
          attemptId,
          installationId,
          keyId: created.id,
          previousKeyIds: previous,
        });
      } catch (reread) {
        logged("fitness.devices.swap_unknown", reread);
      }
      // The read finds the keys this swap's own commit replaced.
      if (outcome.outcome === "committed")
        swapped = { activated: true, replaced: outcome.replaced };
      // With no answer, both keys are left for a later enrollment to
      // settle and clean up.
      else if (outcome.outcome === "unknown") revokeNew = false;
    }
  }
  if (!swapped.activated) {
    if (revokeNew) {
      await revokeQuietly(
        created.id,
        "This connection could not be completed.",
      );
      await settleEnrollment(userId, attemptId, "failed", createdAt).catch(
        () => undefined,
      );
    }
    return issuanceFailed();
  }
  const revokeBy = deadlineIn(timing.replacedRevokeMs);
  for (const keyId of swapped.replaced)
    await revokeQuietly(
      keyId,
      "Replaced by a new connection from this iPhone.",
      revokeBy,
    );
  // A later enrollment for this installation may have replaced this key
  // meanwhile, so the key is returned only while it is still current. The
  // check is best effort: a read that fails returns the key, since the swap
  // committed. The app never replaces a stored key with one from a lower
  // sequence, so a stale key it gets this way never takes the place of a
  // later attempt's.
  let current = true;
  try {
    current = await deviceKeyActive({
      owner: userId,
      keyId: created.id,
      enrollment: attemptId,
      installationId,
    });
  } catch (error) {
    logged("fitness.devices.recheck_failed", error);
  }
  if (!current) {
    await revokeQuietly(
      created.id,
      "Replaced by a new connection from this iPhone.",
    );
    return issuanceFailed();
  }
  const reply: DeviceEnrollResponse = {
    secret: created.secret,
    accountTimezone: timezone,
    userId,
    email,
  };
  return json(reply, 201);
}

/**
 * DELETE /api/health/devices/current: disconnects the device key that sends
 * the request. One short transaction under the account lock stops it
 * importing, waiting for an import already running with it; then Clerk
 * revokes it. A key that is not its installation's current key fails with
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
    current = await deactivateDeviceKey(key);
  } catch {
    return authUnavailable({
      "Retry-After": String(deviceLimits.busySeconds),
    });
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
