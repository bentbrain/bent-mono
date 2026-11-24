import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { fitnessScopes } from "@bent/fitness-contracts";
import type { ApiErrorCode } from "@bent/fitness-contracts";
import { allowedEmails, configurationReady, mcpResource } from "./config";

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
 * - `invalid`: Clerk identified the token as unknown, revoked or expired.
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
 * | Clerk reason                | Produced when                                                    | Failure       |
 * | --------------------------- | ---------------------------------------------------------------- | ------------- |
 * | `token-invalid`             | The Backend API answers 404: the key or token is unknown, revoked or expired; or an OAuth JWT cannot be decoded | `invalid`     |
 * | `token-verification-failed` | An OAuth JWT fails its signature, expiry or audience check, or its signing keys cannot be loaded | `rejected`    |
 * | `token-type-mismatch`       | The token is not one of the accepted types                       | `rejected`    |
 * | `secret-key-invalid`        | The Backend API answers 401 to Fitness's secret key              | `unavailable` |
 * | `unexpected-error`          | Any other Backend API status, or a network failure               | `unavailable` |
 * | anything else               | Session-token reasons, which bearer-only requests do not reach   | `rejected`    |
 *
 * Only `invalid` is definitive for a device key: the app discards its key
 * only on `key_invalid`, so a reason whose cause can be on Clerk's side never
 * maps there. A thrown error is `unavailable`.
 */
export const clerkReasonFailure: Record<string, BearerFailure> = {
  "token-invalid": "invalid",
  "token-verification-failed": "rejected",
  "token-type-mismatch": "rejected",
  "secret-key-invalid": "unavailable",
  "unexpected-error": "unavailable",
};

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
): Promise<BearerCheck> {
  const resource = mcpResource();
  if (!configurationReady() || !resource)
    return { ok: false, failure: "unconfigured" };
  const bearer = bearerOnly(request);
  if (!bearer) return { ok: false, failure: "missing" };
  let state;
  try {
    state = await clerkClient().authenticateRequest(bearer, {
      acceptsToken: accepts,
      // Clerk checks OAuth tokens against this audience. API keys have none.
      audience: resource,
      publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
      secretKey: process.env.CLERK_SECRET_KEY,
    });
  } catch (error) {
    return { ok: false, failure: "unavailable", error };
  }
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
  return {
    ok: false,
    failure: clerkReasonFailure[String(state.reason)] ?? "rejected",
  };
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
  | { kind: "device"; owner: string }
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
  return device ? { kind: "device", owner } : { kind: "owner", owner, access };
}
