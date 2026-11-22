import { createFileRoute } from "@tanstack/react-router";
import { resourceMetadata } from "../server/mcp-http";
export const Route = createFileRoute(
  "/.well-known/oauth-protected-resource/api/mcp",
)({
  server: { handlers: { GET: () => resourceMetadata() } },
});
