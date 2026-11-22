import { createFileRoute } from "@tanstack/react-router";
import { resourceMetadata } from "../server/mcp-http";
export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: { handlers: { GET: () => resourceMetadata() } },
});
