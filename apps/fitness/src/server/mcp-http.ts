import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentAuthError, requireAgentOwner } from "./auth";
import { authorizationServer } from "./config";
import { createFitnessMcpServer } from "./mcp";

const mcpPath = "/api/mcp";
const metadataPath = "/.well-known/oauth-protected-resource";
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

/** OAuth protected resource metadata (RFC 9728) for the MCP endpoint. */
export function resourceMetadata(request: Request) {
  const issuer = authorizationServer();
  if (!issuer)
    return json({ error: "Account services need configuration." }, 503);
  const origin = new URL(request.url).origin;
  return json(
    {
      resource: origin + mcpPath,
      resource_name: "Fitness",
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["profile", "email"],
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

function unauthorized(request: Request, description: string) {
  const metadata = new URL(request.url).origin + metadataPath + mcpPath;
  return json({ error: "invalid_token", error_description: description }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${metadata}", error="invalid_token", error_description="${description}"`,
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
  return (
    !origin ||
    origin === new URL(request.url).origin ||
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
  let owner: string;
  try {
    owner = await requireAgentOwner();
  } catch (error) {
    if (error instanceof AgentAuthError)
      return cors(unauthorized(request, error.message), origin);
    throw error;
  }
  if (request.method !== "POST")
    return cors(
      json({ error: "Use POST for this stateless endpoint." }, 405, {
        Allow: "POST, OPTIONS",
      }),
      origin,
    );
  const server = createFitnessMcpServer(owner);
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
