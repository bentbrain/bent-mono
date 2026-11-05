export const ANONYMOUS_SESSION_COOKIE = "__Host-forever_tee_session";

interface AnonymousSessionCookieOptions {
  readonly httpOnly: true;
  readonly maxAge: number;
  readonly path: "/";
  readonly sameSite: "lax";
  readonly secure: true;
}

export const anonymousSessionCookieOptions: AnonymousSessionCookieOptions = {
  httpOnly: true,
  maxAge: 365 * 24 * 60 * 60,
  path: "/",
  sameSite: "lax",
  secure: true,
};

export function createAnonymousSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function anonymousOwnerId(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
