import { createFileRoute } from "@tanstack/react-router";
import { authorizationMetadata } from "../server/mcp-http";
export const Route = createFileRoute("/.well-known/oauth-authorization-server")(
  { server: { handlers: { GET: () => authorizationMetadata() } } },
);
