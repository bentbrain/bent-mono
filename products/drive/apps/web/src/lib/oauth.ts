import { z } from "zod";

import { reveal } from "./config";
import { open, randomToken, seal } from "./crypto";

import type { AppConfig } from "./config";

const authorizeStateSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  clientState: z.string().min(1),
  codeChallenge: z.string().min(43).max(128),
  resource: z.string().url(),
  scopes: z.string().min(1),
  userId: z.string().uuid(),
  expiresAtEpoch: z.number().int().positive(),
});

export const dynamicClientRegistrationSchema = z.object({
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  client_name: z.string().min(1).max(120).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

export const authorizationRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  state: z.string().min(1),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  resource: z.string().url(),
  scope: z.string().optional(),
});

export type AuthorizeState = z.infer<typeof authorizeStateSchema>;

const supportedScopes: readonly string[] = ["tesla.read"];

export function normalizeRequestedScopes(requested: string | undefined): string {
  const scopes = requested
    ? requested.split(/\s+/).map((scope) => scope.trim()).filter(Boolean)
    : ["tesla.read"];
  const uniqueScopes = [...new Set(scopes)];
  if (uniqueScopes.length === 0 || uniqueScopes.some((scope) => !supportedScopes.includes(scope))) {
    throw new Error("The request includes an unsupported scope.");
  }
  if (!uniqueScopes.includes("tesla.read")) {
    throw new Error("The tesla.read scope is required.");
  }
  return uniqueScopes.join(" ");
}

export function hasDuplicateParameters(
  parameters: URLSearchParams,
  allowedIdenticalParameters: readonly string[] = []
): boolean {
  const values = new Map<string, string>();
  for (const [name, value] of parameters) {
    const previous = values.get(name);
    if (previous === undefined) {
      values.set(name, value);
      continue;
    }
    if (!allowedIdenticalParameters.includes(name) || previous !== value) {
      return true;
    }
  }
  return false;
}

export function isAllowedOAuthRedirect(uri: string, allowLocal: boolean): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  if (url.origin === "https://chatgpt.com") {
    return (
      url.pathname.startsWith("/connector/oauth/") ||
      url.pathname === "/connector_platform_oauth_redirect"
    );
  }

  if (!allowLocal) {
    return false;
  }
  const localHosts: readonly string[] = ["localhost", "127.0.0.1", "::1"];
  return localHosts.includes(url.hostname) && (url.protocol === "http:" || url.protocol === "https:");
}

function sealAuthorizeState(state: AuthorizeState, config: AppConfig): string {
  return seal(
    JSON.stringify(authorizeStateSchema.parse(state)),
    reveal(config.tokenEncryptionKey)
  );
}

export function openAuthorizeState(value: string, config: AppConfig, nowEpoch = Date.now() / 1000): AuthorizeState {
  const plaintext = open(value, reveal(config.tokenEncryptionKey));
  const parsedJson: unknown = JSON.parse(plaintext);
  const state = authorizeStateSchema.parse(parsedJson);
  if (state.expiresAtEpoch <= nowEpoch) {
    throw new Error("The authorization request expired. Start the connection again.");
  }
  return state;
}

export function buildTeslaAuthorizationUrl(state: AuthorizeState, config: AppConfig): URL {
  const teslaState = sealAuthorizeState(state, config);
  const url = new URL(config.teslaAuthorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.teslaClientId,
    redirect_uri: config.teslaRedirectUri,
    scope: config.teslaScopes,
    state: teslaState,
    nonce: randomToken("nonce_"),
    locale: "en-AU",
    prompt_missing_scopes: "true",
    require_requested_scopes: "true",
  }).toString();
  return url;
}

export function oauthErrorResponse(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    }
  );
}

export function redirectWithOAuthResult(
  redirectUri: string,
  state: string,
  result: { code: string } | { error: string; description: string }
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("state", state);
  if ("code" in result) {
    url.searchParams.set("code", result.code);
  } else {
    url.searchParams.set("error", result.error);
    url.searchParams.set("error_description", result.description);
  }
  return Response.redirect(url, 303);
}
