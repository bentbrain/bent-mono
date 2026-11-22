export function configurationReady() {
  return Boolean(
    process.env.DATABASE_URL &&
    process.env.CLERK_SECRET_KEY &&
    process.env.VITE_CLERK_PUBLISHABLE_KEY &&
    process.env.FITNESS_ALLOWED_EMAILS?.trim(),
  );
}
export function allowedEmails() {
  return new Set(
    (process.env.FITNESS_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}
/** The Clerk Frontend API origin, which issues OAuth tokens to connected apps. */
export function authorizationServer() {
  const key = process.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";
  const encoded = /^pk_(?:test|live)_(.+)$/.exec(key)?.[1];
  if (!encoded) return null;
  const host = Buffer.from(encoded, "base64")
    .toString("utf8")
    .replace(/\$$/, "");
  return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
}
