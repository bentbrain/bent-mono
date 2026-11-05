import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Data, Effect } from "effect";

import type { AppConfig } from "@/lib/config";
import { AppConfigService } from "@/lib/config";
import { hashToken } from "@/lib/crypto";
import { getAccessSession } from "@/lib/db/store";
import { createHostedMcpServer } from "@/lib/mcp/server";
import { runAppResponse } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 30;

class McpTransportError extends Data.TaggedError("McpTransportError")<{
  operation: "connect" | "handle" | "close";
  message: string;
}> {}

export function OPTIONS(request: Request): Promise<Response> {
  const program = AppConfigService.pipe(
    Effect.map((config) => {
      const origin = request.headers.get("origin");
      if (!isAllowedOrigin(origin, config)) {
        return Response.json({ error: "invalid_origin" }, { status: 403 });
      }
      return withCors(new Response(null, { status: 204 }), origin);
    })
  );
  return runAppResponse("route.mcp.options", program, { "http.request.method": request.method });
}

export function GET(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export function DELETE(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

function handleMcpRequest(request: Request): Promise<Response> {
  const program = Effect.gen(function* () {
    const config = yield* AppConfigService;
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, config)) {
      return Response.json(
        { error: "invalid_origin", error_description: "This browser origin is not allowed." },
        { status: 403, headers: { "cache-control": "no-store" } }
      );
    }
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return unauthorized(config, origin, "Authentication is required.");
    }
    const accessToken = authorization.slice("Bearer ".length).trim();
    if (!accessToken) {
      return unauthorized(config, origin, "The bearer token is empty.");
    }

    const session = yield* getAccessSession(hashToken(accessToken));
    if (session?.resource !== config.mcpResource) {
      return unauthorized(config, origin, "The bearer token is invalid or expired.");
    }
    const scopes = session.scopes.split(/\s+/).filter(Boolean);
    if (!scopes.includes("tesla.read")) {
      return unauthorized(
        config,
        origin,
        "The tesla.read scope is required.",
        "insufficient_scope",
        403
      );
    }

    const response = yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const server = createHostedMcpServer(config);
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        yield* Effect.tryPromise({
          try: () => server.connect(transport),
          catch: (error) =>
            new McpTransportError({
              operation: "connect",
              message: error instanceof Error ? error.message : "Could not connect MCP transport.",
            }),
        });
        return { server, transport };
      }),
      ({ transport }) =>
        Effect.tryPromise({
          try: () =>
            transport.handleRequest(request, {
              authInfo: {
                token: accessToken,
                clientId: session.clientId,
                scopes,
                expiresAt: Math.floor(session.expiresAtEpoch),
                resource: new URL(session.resource),
                extra: { connectionId: session.connectionId },
              },
            }),
          catch: (error) =>
            new McpTransportError({
              operation: "handle",
              message: error instanceof Error ? error.message : "MCP request handling failed.",
            }),
        }),
      ({ server }) =>
        Effect.tryPromise({
          try: () => server.close(),
          catch: (error) =>
            new McpTransportError({
              operation: "close",
              message: error instanceof Error ? error.message : "MCP server cleanup failed.",
            }),
        }).pipe(Effect.catchAll((error) => Effect.logWarning("mcp.server.close_failed", error)))
    );
    yield* Effect.logInfo("mcp.request.complete").pipe(
      Effect.annotateLogs({ clientId: session.clientId, connectionId: session.connectionId })
    );
    return withCors(response, origin);
  });

  return runAppResponse("route.mcp.request", program, {
    "http.request.method": request.method,
    "url.path": "/mcp",
  });
}

function unauthorized(
  config: AppConfig,
  origin: string | null,
  description: string,
  error = "invalid_token",
  status = 401
): Response {
  const scope = error === "insufficient_scope" ? ', scope="tesla.read"' : "";
  return withCors(
    new Response(JSON.stringify({ error, error_description: description }), {
      status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${config.protectedResourceMetadataUrl}", error="${error}", error_description="${description}"${scope}`,
        "cache-control": "no-store",
      },
    }),
    origin
  );
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.append("vary", "Origin");
  }
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, mcp-protocol-version, mcp-session-id"
  );
  headers.set("access-control-expose-headers", "mcp-session-id, www-authenticate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isAllowedOrigin(origin: string | null, config: AppConfig): boolean {
  if (!origin) {
    return true;
  }
  const allowedOrigins = new Set([
    new URL(config.appUrl).origin,
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://platform.openai.com",
  ]);
  return allowedOrigins.has(origin);
}
