import { mcpProtectedResourceMetadataResponse } from "@/lib/metadata";
import { runAppResponse } from "@/lib/runtime";

export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return runAppResponse("route.oauth.protected_resource_mcp", mcpProtectedResourceMetadataResponse);
}
