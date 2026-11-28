import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  AgentAuthError,
  AgentScopeError,
  agentScopes,
  requireAgentOwner,
} from "./auth";
import {
  authorizationServer,
  mcpResource,
  targetsScopeEnabled,
} from "./config";
import { createFitnessMcpServer } from "./mcp";

/** Browser origins allowed to call the endpoint. Server-side clients send no Origin. */
const clientOrigins = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
  "https://claude.ai",
]);
const noStore = { "Cache-Control": "no-store" };

function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, {
    status,
    headers: { ...noStore, ...headers },
  });
}

/** The scopes assistants are told to request. */
export function advertisedScopes() {
  return [
    agentScopes.read,
    agentScopes.write,
    ...(targetsScopeEnabled() ? [agentScopes.targets] : []),
  ];
}

/** OAuth protected resource metadata (RFC 9728) for the MCP endpoint. */
export function resourceMetadata() {
  const issuer = authorizationServer();
  const resource = mcpResource();
  if (!issuer || !resource)
    return json({ error: "Account services need configuration." }, 503);
  return json(
    {
      resource,
      resource_name: "Fitness",
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: advertisedScopes(),
    },
    200,
    { "Access-Control-Allow-Origin": "*" },
  );
}

/** Mirrors the Clerk authorization server metadata for clients that read it from the resource origin. */
export async function authorizationMetadata() {
  const issuer = authorizationServer();
  if (!issuer)
    return json({ error: "Account services need configuration." }, 503);
  const upstream = await fetch(
    issuer + "/.well-known/oauth-authorization-server",
    { headers: { Accept: "application/json" } },
  );
  if (!upstream.ok)
    return json({ error: "The sign-in service is unavailable." }, 502);
  return json(await upstream.json(), 200, {
    "Access-Control-Allow-Origin": "*",
  });
}

/** A Bearer challenge naming the scopes to request and where to sign in. */
function challenge(
  error: "invalid_token" | "insufficient_scope",
  description: string,
  status: 401 | 403,
) {
  const resource = mcpResource();
  const metadata = resource
    ? `, resource_metadata="${new URL(resource).origin}/.well-known/oauth-protected-resource/api/mcp"`
    : "";
  const scope = advertisedScopes().join(" ");
  return json({ error, error_description: description }, status, {
    "WWW-Authenticate": `Bearer error="${error}", error_description="${description}", scope="${scope}"${metadata}`,
  });
}

function cors(response: Response, origin: string | null) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "authorization, content-type, mcp-protocol-version",
  );
  headers.set("Access-Control-Expose-Headers", "www-authenticate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const resource = mcpResource();
  return (
    !origin ||
    (resource !== null && origin === new URL(resource).origin) ||
    clientOrigins.has(origin)
  );
}

export function preflight(request: Request) {
  if (!allowedOrigin(request))
    return json({ error: "This origin is not allowed." }, 403);
  return cors(
    new Response(null, { status: 204 }),
    request.headers.get("origin"),
  );
}

/** Stateless Streamable HTTP: each POST carries its own token and JSON reply. */
export async function handleMcp(request: Request) {
  const origin = request.headers.get("origin");
  if (!allowedOrigin(request))
    return json({ error: "This origin is not allowed." }, 403);
  let agent: Awaited<ReturnType<typeof requireAgentOwner>>;
  try {
    agent = await requireAgentOwner(request);
  } catch (error) {
    if (error instanceof AgentAuthError)
      return cors(challenge("invalid_token", error.message, 401), origin);
    if (error instanceof AgentScopeError)
      return cors(challenge("insufficient_scope", error.message, 403), origin);
    throw error;
  }
  if (request.method !== "POST")
    return cors(
      json({ error: "Use POST for this stateless endpoint." }, 405, {
        Allow: "POST, OPTIONS",
      }),
      origin,
    );
  const server = createFitnessMcpServer(agent.owner, agent.access);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return cors(await transport.handleRequest(request), origin);
  } finally {
    await server.close().catch(() => undefined);
  }
}
