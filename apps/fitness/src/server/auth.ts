import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { deviceKeyKind, fitnessScopes } from "@bent/fitness-contracts";
import type { ApiErrorCode } from "@bent/fitness-contracts";
import { allowedEmails, configurationReady, mcpResource } from "./config";
import { deviceKeyActive } from "./store";
import type { DeviceKeyClaims } from "./store";

export class AgentAuthError extends Error {}
/** The token is valid but grants no Fitness access. */
export class AgentScopeError extends Error {}
export const agentScopes = {
  read: fitnessScopes.read,
  write: fitnessScopes.write,
} as const;
export type AgentAccess = { read: boolean; write: boolean };

/** The verified primary email, when it is on the invitation list. */
export async function invitedEmail(userId: string) {
  const user = await clerkClient().users.getUser(userId);
  const email = user.emailAddresses
    .find(
      (e) =>
        e.id === user.primaryEmailAddressId &&
        e.verification?.status === "verified",
    )
    ?.emailAddress.toLowerCase();
  return email && allowedEmails().has(email) ? email : null;
}

/** Returns the user ID when its verified primary email is invited. */
async function invited(userId: string) {
  return (await invitedEmail(userId)) ? userId : null;
}

export async function requireOwner() {
  if (!configurationReady())
    throw new Error(
      "Account services need configuration. Contact the app owner.",
    );
  const { userId } = await auth();
  if (!userId) throw new Error("Sign in to access your fitness data.");
  const owner = await invited(userId);
  if (!owner)
    throw new Error("This account needs an invitation. Contact the app owner.");
  return owner;
}

/** The Fitness access a verified token's scopes grant. */
export function agentAccess(
  tokenType: "oauth_token" | "api_key",
  scopes: string[],
): AgentAccess {
  const ownerKey = tokenType === "api_key" && scopes.length === 0;
  return {
    read: ownerKey || scopes.includes(agentScopes.read),
    write: ownerKey || scopes.includes(agentScopes.write),
  };
}

type BearerToken = "oauth_token" | "api_key";

/** A bearer token Clerk verified, with what its route checks. */
type VerifiedBearer = {
  id: string;
  tokenType: BearerToken;
  userId: string | null;
  scopes: string[];
  /** The OAuth application that requested an OAuth token. */
  clientId: string | null;
  /** An API key's custom claims. */
  claims: Record<string, unknown> | null;
};

/**
 * Why a bearer was not verified:
 * - `unconfigured`: Fitness has no Clerk keys or MCP resource.
 * - `missing`: the request has no bearer token.
 * - `invalid`: Clerk identified the token as unknown, revoked or expired,
 *   or the token's own claims show it expired or names another audience.
 * - `rejected`: Clerk did not verify the token as an accepted type, for a
 *   reason that does not show the token itself is unusable.
 * - `unavailable`: Clerk could not be reached or rejected Fitness's own
 *   credentials, or verification failed unexpectedly. Retrying can succeed.
 */
export type BearerFailure =
  "unconfigured" | "missing" | "invalid" | "rejected" | "unavailable";
export type BearerCheck =
  | { ok: true; bearer: VerifiedBearer }
  | { ok: false; failure: BearerFailure; error?: unknown };

/**
 * How Clerk's signed-out reasons map to failures. `@clerk/backend` 3.29
 * reports machine-token verification errors as the request state's
 * `reason`; this table lists every reason it produces for API keys and
 * OAuth tokens.
 *
 * | Clerk reason                | Produced when                                                                                         | Failure                  |
 * | --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
 * | `token-invalid`             | The Backend API answers 404: the key or token is unknown, revoked or expired; or a JWT cannot be decoded | `invalid`                |
 * | `token-verification-failed` | An OAuth JWT fails its signature, expiry or audience check, or Clerk's signing keys cannot be loaded | see below                |
 * | `token-type-mismatch`       | The token is not one of the accepted types                                                            | `rejected`               |
 * | `secret-key-invalid`        | The Backend API answers 401 to Fitness's secret key                                                   | `unavailable`            |
 * | `unexpected-error`          | Any other Backend API status, or a network failure                                                    | `unavailable`            |
 * | anything else               | Reasons bearer-only machine-token requests do not produce                                             | `unavailable`            |
 *
 * For an OAuth JWT, `token-verification-failed` covers both a bad token and
 * a signing-key outage, so Fitness reads the token's own claims: an `exp` in
 * the past, or an `aud` that does not name the MCP endpoint, makes it
 * `invalid`. Anything else under that reason is `unavailable`, since
 * retrying can succeed. For an opaque OAuth token, the SDK reports that
 * reason only when the token's audience does not match, which is `invalid`.
 *
 * Only `invalid` is definitive for a device key: the app discards its key
 * only on `key_invalid`, so a reason whose cause can be on Clerk's side never
 * maps there. A thrown error is `unavailable`.
 */
export const clerkReasonFailure: Record<string, BearerFailure> = {
  "token-invalid": "invalid",
  "token-type-mismatch": "rejected",
  "secret-key-invalid": "unavailable",
  "unexpected-error": "unavailable",
};

/** Clerk allows this much clock skew when it checks expiry. */
const clockSkewMs = 5000;

/**
 * Whether a token that failed Clerk's verification is unusable here. For a
 * JWT, its own claims decide: it has expired, or its audience is missing or
 * does not name `resource`. The claims are read without verifying the
 * signature, which only chooses between refusals. An opaque token fails
 * verification only on its audience.
 */
function conclusivelyUnusable(token: string, resource: string) {
  const parts = token.split(".");
  // Opaque tokens fail verification only on their audience.
  if (parts.length !== 3) return true;
  const payload = parts[1];
  if (!payload) return false;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!claims || typeof claims !== "object") return false;
  const { exp, aud } = claims as { exp?: unknown; aud?: unknown };
  if (typeof exp === "number" && exp * 1000 <= Date.now() - clockSkewMs)
    return true;
  const audiences = [aud].flat().filter((a) => typeof a === "string");
  return !audiences.includes(resource);
}

/** A copy of the request carrying only its bearer token, without cookies. */
function bearerOnly(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization.trim())) return null;
  return new Request(request.url, {
    method: "GET",
    headers: { authorization: authorization.trim() },
  });
}

/**
 * Verifies the request's bearer token as one of the accepted Clerk machine
 * token types. OAuth tokens must name the MCP endpoint as their audience.
 * Cookies are ignored, so a browser session never authorizes these routes.
 */
export async function verifyBearer(
  request: Request,
  accepts: BearerToken[],
  options: { timeoutMs?: number } = {},
): Promise<BearerCheck> {
  const resource = mcpResource();
  if (!configurationReady() || !resource)
    return { ok: false, failure: "unconfigured" };
  const bearer = bearerOnly(request);
  if (!bearer) return { ok: false, failure: "missing" };
  let state;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verification = clerkClient().authenticateRequest(bearer, {
      acceptsToken: accepts,
      // Clerk checks OAuth tokens against this audience. API keys have none.
      audience: resource,
      publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    const timeoutMs = options.timeoutMs;
    state =
      timeoutMs === undefined
        ? await verification
        : await Promise.race([
            verification,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), timeoutMs);
            }),
          ]);
  } catch (error) {
    return { ok: false, failure: "unavailable", error };
  } finally {
    clearTimeout(timer);
  }
  if (!state) return { ok: false, failure: "unavailable" };
  const result = state.toAuth();
  if (
    result?.isAuthenticated &&
    (result.tokenType === "oauth_token" || result.tokenType === "api_key") &&
    accepts.includes(result.tokenType)
  )
    return {
      ok: true,
      bearer: {
        id: result.id,
        tokenType: result.tokenType,
        userId: result.userId,
        scopes: result.scopes,
        clientId: result.tokenType === "oauth_token" ? result.clientId : null,
        claims: result.tokenType === "api_key" ? result.claims : null,
      },
    };
  if (state.isAuthenticated) return { ok: false, failure: "rejected" };
  const reason = String(state.reason);
  if (reason === "token-verification-failed") {
    const token = bearer.headers.get("authorization")?.split(/\s+/)[1] ?? "";
    return {
      ok: false,
      failure: conclusivelyUnusable(token, resource)
        ? "invalid"
        : "unavailable",
    };
  }
  return { ok: false, failure: clerkReasonFailure[reason] ?? "unavailable" };
}

/**
 * Verifies a bearer token of an accepted type and returns its invited owner
 * and the access its scopes grant.
 */
async function requireTokenOwner(request: Request, accepts: BearerToken[]) {
  const check = await verifyBearer(request, accepts);
  if (!check.ok) {
    if (check.failure === "unconfigured")
      throw new AgentAuthError(
        "Account services need configuration. Contact the app owner.",
      );
    if (check.error !== undefined) throw check.error;
    throw new AgentAuthError(
      accepts.includes("oauth_token")
        ? "Connect with an invited Fitness account."
        : "Send a Fitness API key as the bearer token.",
    );
  }
  const { bearer } = check;
  const userId = bearer.userId;
  if (!userId?.startsWith("user_"))
    throw new AgentAuthError("Use a token that belongs to a Fitness account.");
  if (bearer.scopes.includes(fitnessScopes.healthImport))
    throw new AgentScopeError(
      "This key only imports Apple Health data. Connect with Fitness read or write access.",
    );
  const access = agentAccess(bearer.tokenType, bearer.scopes);
  if (!access.read && !access.write)
    throw new AgentScopeError(
      "Approve Fitness read or write access for this connection.",
    );
  const owner = await invited(userId);
  if (!owner)
    throw new AgentAuthError(
      "This account needs an invitation. Contact the app owner.",
    );
  return { owner, access };
}

/**
 * Authenticates an agent request from its bearer token: a Clerk OAuth access
 * token issued for this MCP endpoint, or a Clerk API key owned by the user.
 * Session cookies are not accepted, so a browser cannot call the agent API
 * on the user's behalf.
 *
 * OAuth tokens and scoped API keys grant what their scopes name:
 * fitness:read for reading and fitness:write for changes. An API key without
 * scopes is one the owner created for their own scripts and grants both.
 * Device keys, which hold fitness:health:import, are refused.
 */
export function requireAgentOwner(request: Request) {
  return requireTokenOwner(request, ["oauth_token", "api_key"]);
}

/** A failed authentication, as the route replies to it. */
export type AuthFailure = {
  status: 401 | 403 | 503;
  error: string;
  code?: ApiErrorCode;
};
const unavailable: AuthFailure = {
  status: 503,
  error: "Account services are unavailable. Try again shortly.",
  code: "auth_unavailable",
};

/**
 * Authenticates an Apple Health import. Only Clerk API keys are accepted;
 * OAuth tokens are issued for the MCP endpoint.
 *
 * A key with fitness:health:import is a device key and gets the device
 * reply. Other keys get the access their scopes grant. A key Clerk reports
 * as unknown, revoked or expired fails with `key_invalid`; a Clerk failure
 * fails with `503 auth_unavailable`, since the key may still be valid.
 */
export async function authenticateImport(
  request: Request,
): Promise<
  | { kind: "device"; owner: string; key: DeviceKeyClaims }
  | { kind: "owner"; owner: string; access: AgentAccess }
  | { kind: "failed"; failure: AuthFailure }
> {
  const fail = (failure: AuthFailure) => ({ kind: "failed" as const, failure });
  const check = await verifyBearer(request, ["api_key"]);
  if (!check.ok) {
    if (check.failure === "unconfigured")
      return fail({
        status: 401,
        error: "Account services need configuration. Contact the app owner.",
        code: "unauthorized",
      });
    if (check.failure === "unavailable") {
      if (check.error !== undefined)
        console.error("fitness.auth.verification_failed", {
          name: check.error instanceof Error ? check.error.name : "unknown",
        });
      return fail(unavailable);
    }
    return fail({
      status: 401,
      error: "Send a Fitness API key as the bearer token.",
      code: check.failure === "invalid" ? "key_invalid" : "unauthorized",
    });
  }
  const { bearer } = check;
  const userId = bearer.userId;
  if (!userId?.startsWith("user_"))
    return fail({
      status: 401,
      error: "Use a token that belongs to a Fitness account.",
      code: "unauthorized",
    });
  const device = bearer.scopes.includes(fitnessScopes.healthImport);
  const access = agentAccess(bearer.tokenType, bearer.scopes);
  if (!device && !access.read && !access.write)
    return fail({
      status: 403,
      error: "Approve Fitness read or write access for this connection.",
    });
  let owner: string | null;
  try {
    owner = await invited(userId);
  } catch {
    return fail(unavailable);
  }
  if (!owner)
    return device
      ? fail({
          status: 403,
          error: "This account needs an invitation. Contact the app owner.",
          code: "not_invited",
        })
      : fail({
          status: 401,
          error: "This account needs an invitation. Contact the app owner.",
          code: "unauthorized",
        });
  if (!device) return { kind: "owner", owner, access };
  // Only the key recorded on its installation's active enrollment imports.
  const key = deviceKeyClaims(bearer);
  let current: boolean;
  try {
    current = key !== null && (await deviceKeyActive(key));
  } catch {
    return fail(unavailable);
  }
  if (!current || !key) {
    await revokeOrphan(bearer.id);
    return fail({
      status: 401,
      error: "This device key is no longer valid. Connect the iPhone again.",
      code: "key_invalid",
    });
  }
  return { kind: "device", owner, key };
}

/**
 * The enrollment a device key names in its claims, or null when the key
 * has no iPhone sync claims in the expected form.
 */
export function deviceKeyClaims(
  bearer: VerifiedBearer,
): DeviceKeyClaims | null {
  const claims = bearer.claims;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    !bearer.userId ||
    claims?.kind !== deviceKeyKind ||
    typeof claims.enrollment !== "string" ||
    typeof claims.installationId !== "string" ||
    !uuid.test(claims.enrollment) ||
    !uuid.test(claims.installationId)
  )
    return null;
  return {
    owner: bearer.userId,
    keyId: bearer.id,
    enrollment: claims.enrollment,
    installationId: claims.installationId,
  };
}

/** Revokes a device key that cannot import, as cleanup. Failure is logged. */
async function revokeOrphan(apiKeyId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      clerkClient().apiKeys.revoke({
        apiKeyId,
        revocationReason: "Not the active key for its iPhone.",
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out")), 10_000);
      }),
    ]);
  } catch (error) {
    console.error("fitness.devices.revoke_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
  } finally {
    clearTimeout(timer);
  }
}
