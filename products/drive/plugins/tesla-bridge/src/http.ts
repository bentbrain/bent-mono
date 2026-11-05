import { createServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpServer } from "./mcp-server.js";
import { createRuntime } from "./runtime.js";

import type { IncomingMessage, ServerResponse } from "node:http";

const runtime = createRuntime();
if (runtime.config.mode === "live") {
  throw new Error(
    "Live HTTP mode is intentionally disabled until OAuth 2.1 resource-server authentication is implemented. Use stdio for developer-only live testing."
  );
}

const allowedMethods = new Set(["POST", "GET", "DELETE"]);

const httpServer = createServer((request, response) => {
  void handleHttpRequest(request, response);
});

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!request.url) {
    response.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "tesla-bridge", mode: runtime.config.mode, status: "ok" }));
    return;
  }

  if (request.method === "OPTIONS" && url.pathname === "/mcp") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, mcp-session-id",
      "access-control-expose-headers": "mcp-session-id",
    });
    response.end();
    return;
  }

  if (url.pathname === "/mcp" && request.method && allowedMethods.has(request.method)) {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-expose-headers", "mcp-session-id");
    const server = createMcpServer(runtime.config, runtime.adapter, runtime.actionStore);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        response.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  response.writeHead(404).end("Not Found");
}

httpServer.listen(runtime.config.port, "127.0.0.1", () => {
  console.log(`Tesla Bridge MCP listening on http://127.0.0.1:${runtime.config.port}/mcp`);
});
