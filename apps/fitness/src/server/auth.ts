import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { allowedEmails, configurationReady, mcpResource } from "./config";

export class AgentAuthError extends Error {}

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

/**
 * Authenticates an agent request from its bearer token: a Clerk OAuth access
 * token issued for this MCP endpoint, or a Clerk API key owned by the user.
 * Session cookies are not accepted, so a browser cannot call the agent API
 * on the user's behalf.
 */
export async function requireAgentOwner(request: Request) {
  const resource = mcpResource();
  if (!configurationReady() || !resource)
    throw new AgentAuthError(
      "Account services need configuration. Contact the app owner.",
    );
  const state = await clerkClient().authenticateRequest(request, {
    acceptsToken: ["oauth_token", "api_key"],
    // Clerk checks OAuth tokens against this audience. API keys have none.
    audience: resource,
    publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  });
  const result = state.toAuth();
  if (
    !result?.isAuthenticated ||
    (result.tokenType !== "oauth_token" && result.tokenType !== "api_key")
  )
    throw new AgentAuthError("Connect with an invited Fitness account.");
  const userId = result.userId;
  if (!userId?.startsWith("user_"))
    throw new AgentAuthError("Use a token that belongs to a Fitness account.");
  const owner = await invited(userId);
  if (!owner)
    throw new AgentAuthError(
      "This account needs an invitation. Contact the app owner.",
    );
  return owner;
}
