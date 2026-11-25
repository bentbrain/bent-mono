import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import { AuthRequest, CodeChallengeMethod, ResponseType, exchangeCodeAsync } from "expo-auth-session";
import { SignInCancelled } from "./logic/connect";

type OAuthSettings = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
};

export function oauthSettings(): OAuthSettings | null {
  const oauth = Constants.expoConfig?.extra?.oauth as Partial<OAuthSettings> | undefined;
  if (!oauth?.issuer || !oauth.clientId || !oauth.redirectUri || !oauth.resource || !oauth.scopes) return null;
  return oauth as OAuthSettings;
}

function randomState() {
  return Array.from(getRandomBytes(24), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Signs in with Clerk in a private browser session using PKCE (S256), and
 * returns the access token for the Fitness resource. The token stays in
 * memory and is used once to connect this iPhone.
 */
export async function authorize(settings: OAuthSettings): Promise<string> {
  const discovery = {
    authorizationEndpoint: `${settings.issuer}/oauth/authorize`,
    tokenEndpoint: `${settings.issuer}/oauth/token`,
  };
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
    throw new Error(result.type === "error" ? result.error?.message ?? "Sign-in failed." : "Sign-in failed.");
  const tokens = await exchangeCodeAsync(
    {
      clientId: settings.clientId,
      code: result.params.code,
      redirectUri: settings.redirectUri,
      extraParams: { code_verifier: request.codeVerifier ?? "", resource: settings.resource },
    },
    discovery,
  );
  return tokens.accessToken;
}
