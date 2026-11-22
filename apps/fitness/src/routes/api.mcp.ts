import { createFileRoute } from "@tanstack/react-router";
import { handleMcp, preflight } from "../server/mcp-http";
export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: ({ request }) => handleMcp(request),
      GET: ({ request }) => handleMcp(request),
      DELETE: ({ request }) => handleMcp(request),
      OPTIONS: ({ request }) => preflight(request),
    },
  },
});
