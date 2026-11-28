import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import {
  AuthRequest,
  CodeChallengeMethod,
  ResponseType,
  TokenError,
  exchangeCodeAsync,
  refreshAsync,
  revokeAsync,
} from "expo-auth-session";
import type { TokenResponse } from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";
import { SignInCancelled } from "./logic/connect";
import { RefreshRejected } from "./account/session";
import type { OAuthClient, SecretStore, Tokens } from "./account/session";

const oauthSchema = z.object({
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  resource: z.string().min(1),
  scopes: z.array(z.string()).min(1),
});
type OAuthSettings = z.infer<typeof oauthSchema>;

/** The build's OAuth settings, or null when the build has none. */
export function oauthSettings(): OAuthSettings | null {
  const parsed = oauthSchema.safeParse(Constants.expoConfig?.extra?.oauth);
  return parsed.success ? parsed.data : null;
}

function randomState() {
  return Array.from(getRandomBytes(24), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tokens(response: TokenResponse): Tokens {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken ?? null,
    expiresAt: response.expiresIn ? (response.issuedAt + response.expiresIn) * 1000 : null,
  };
}

/**
 * Clerk's OAuth endpoints for the Fitness iOS application. Sign-in runs in
 * a private browser session with PKCE (S256) and a random `state`, and
 * names the Fitness MCP endpoint as the token's audience.
 */
export function clerkOAuth(settings: OAuthSettings): OAuthClient {
  const discovery = {
    authorizationEndpoint: `${settings.issuer}/oauth/authorize`,
    tokenEndpoint: `${settings.issuer}/oauth/token`,
    revocationEndpoint: `${settings.issuer}/oauth/token/revoke`,
  };
  return {
    async authorize() {
      const request = new AuthRequest({
        clientId: settings.clientId,
        redirectUri: settings.redirectUri,
        scopes: settings.scopes,
        responseType: ResponseType.Code,
        usePKCE: true,
        codeChallengeMethod: CodeChallengeMethod.S256,
        state: randomState(),
        extraParams: { resource: settings.resource },
      });
      // The request checks the returned state against its own.
      const result = await request.promptAsync(discovery, { preferEphemeralSession: true });
      if (result.type === "cancel" || result.type === "dismiss") throw new SignInCancelled();
      if (result.type !== "success" || !result.params.code)
        throw new Error(result.type === "error" ? (result.error?.message ?? "Sign-in failed.") : "Sign-in failed.");
      return tokens(
        await exchangeCodeAsync(
          {
            clientId: settings.clientId,
            code: result.params.code,
            redirectUri: settings.redirectUri,
            extraParams: { code_verifier: request.codeVerifier ?? "", resource: settings.resource },
          },
          discovery,
        ),
      );
    },
    async refresh(refreshToken) {
      try {
        return tokens(
          await refreshAsync(
            { clientId: settings.clientId, refreshToken, extraParams: { resource: settings.resource } },
            discovery,
          ),
        );
      } catch (error) {
        if (
          error instanceof TokenError &&
          ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code)
        )
          throw new RefreshRejected(error.message);
        throw error;
      }
    },
    async revoke(refreshToken) {
      await revokeAsync({ clientId: settings.clientId, token: refreshToken }, discovery);
    },
  };
}

const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** The Keychain, for the account's refresh token. */
export const keychainStore: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key, keychain),
  set: (key, value) => SecureStore.setItemAsync(key, value, keychain),
  remove: (key) => SecureStore.deleteItemAsync(key, keychain),
};
