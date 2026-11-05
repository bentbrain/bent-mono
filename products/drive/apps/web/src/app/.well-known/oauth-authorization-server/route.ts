import { authorizationServerMetadataResponse } from "@/lib/metadata";
import { runAppResponse } from "@/lib/runtime";

export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return runAppResponse("route.oauth.authorization_server", authorizationServerMetadataResponse);
}
