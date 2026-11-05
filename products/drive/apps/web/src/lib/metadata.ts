import { Effect } from "effect";

import { AppConfigService } from "./config";

export const mcpProtectedResourceMetadataResponse = AppConfigService.pipe(
  Effect.map((config) =>
    Response.json(
      {
        resource: config.mcpResource,
        authorization_servers: [config.appUrl],
        scopes_supported: ["tesla.read"],
        bearer_methods_supported: ["header"],
        resource_documentation: `${config.appUrl}/docs`,
      },
      { headers: { "cache-control": "public, max-age=300" } }
    )
  ),
  Effect.withSpan("oauth.metadata.protected_resource")
);

export const rootProtectedResourceMetadataResponse = AppConfigService.pipe(
  Effect.map((config) =>
    Response.json(
      {
        resource: config.appUrl,
        authorization_servers: [config.appUrl],
        scopes_supported: ["tesla.read"],
        bearer_methods_supported: ["header"],
        resource_documentation: `${config.appUrl}/docs`,
      },
      { headers: { "cache-control": "public, max-age=300" } }
    )
  ),
  Effect.withSpan("oauth.metadata.protected_resource_root")
);

export const authorizationServerMetadataResponse = AppConfigService.pipe(
  Effect.map((config) =>
    Response.json(
      {
        issuer: config.appUrl,
        authorization_endpoint: `${config.appUrl}/oauth/authorize`,
        token_endpoint: `${config.appUrl}/oauth/token`,
        registration_endpoint: `${config.appUrl}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["tesla.read"],
      },
      { headers: { "cache-control": "public, max-age=300" } }
    )
  ),
  Effect.withSpan("oauth.metadata.authorization_server")
);
