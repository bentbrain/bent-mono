import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { allowedEmails, configurationReady, mcpResource } from "./config";

export class AgentAuthError extends Error {}
/** The token is valid but grants no Fitness access. */
export class AgentScopeError extends Error {}
export const agentScopes = {
  read: "fitness:read",
  write: "fitness:write",
} as const;
export type AgentAccess = { read: boolean; write: boolean };

/** Returns the user ID when its verified primary email is invited. */
async function invited(userId: string) {
  const user = await clerkClient().users.getUser(userId);
  const email = user.emailAddresses
    .find(
      (e) =>
        e.id === user.primaryEmailAddressId &&
        e.verification?.status === "verified",
    )
    ?.emailAddress.toLowerCase();
  return email && allowedEmails().has(email) ? userId : null;
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

/**
 * Verifies a bearer token of an accepted type and returns its invited owner
 * and the access its scopes grant.
 */
async function requireTokenOwner(request: Request, accepts: BearerToken[]) {
  const resource = mcpResource();
  if (!configurationReady() || !resource)
    throw new AgentAuthError(
      "Account services need configuration. Contact the app owner.",
    );
  const state = await clerkClient().authenticateRequest(request, {
    acceptsToken: accepts,
    // Clerk checks OAuth tokens against this audience. API keys have none.
    audience: resource,
    publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  });
  const result = state.toAuth();
  if (
    !result?.isAuthenticated ||
    (result.tokenType !== "oauth_token" && result.tokenType !== "api_key") ||
    !accepts.includes(result.tokenType)
  )
    throw new AgentAuthError(
      accepts.includes("oauth_token")
        ? "Connect with an invited Fitness account."
        : "Send a Fitness API key as the bearer token.",
    );
  const userId = result.userId;
  if (!userId?.startsWith("user_"))
    throw new AgentAuthError("Use a token that belongs to a Fitness account.");
  const access = agentAccess(result.tokenType, result.scopes);
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
 */
export function requireAgentOwner(request: Request) {
  return requireTokenOwner(request, ["oauth_token", "api_key"]);
}

/**
 * Authenticates an import from the owner's own scripts and apps. Only Clerk
 * API keys are accepted; OAuth tokens are issued for the MCP endpoint.
 */
export function requireApiKeyOwner(request: Request) {
  return requireTokenOwner(request, ["api_key"]);
}
