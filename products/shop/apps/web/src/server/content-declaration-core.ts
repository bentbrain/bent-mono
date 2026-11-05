export const CONTENT_DECLARATION_COOKIE = "__Host-bent_shirt_declaration";
export const CONTENT_DECLARATION_FIELD = "contentDeclaration";
export const CONTENT_DECLARATION_VERSION = "portrait-v1";

interface ContentDeclarationCookieOptions {
  readonly httpOnly: true;
  readonly maxAge: number;
  readonly path: "/";
  readonly sameSite: "lax";
  readonly secure: true;
}

export const contentDeclarationCookieOptions: ContentDeclarationCookieOptions = {
  httpOnly: true,
  maxAge: 365 * 24 * 60 * 60,
  path: "/",
  sameSite: "lax",
  secure: true,
};

export async function signContentDeclaration(ownerId: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    declarationPayload(ownerId),
  );
  return `${CONTENT_DECLARATION_VERSION}.${base64UrlEncode(signature)}`;
}

export async function verifyContentDeclaration(
  value: string,
  ownerId: string,
  secret: string,
) {
  const separator = value.indexOf(".");
  if (separator <= 0) return false;
  if (value.slice(0, separator) !== CONTENT_DECLARATION_VERSION) return false;
  const signature = base64UrlDecode(value.slice(separator + 1));
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    declarationPayload(ownerId),
  );
}

function declarationPayload(ownerId: string) {
  return new TextEncoder().encode(`${CONTENT_DECLARATION_VERSION}:${ownerId}`);
}

function base64UrlEncode(value: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}
