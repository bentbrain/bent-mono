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
/**
 * The canonical MCP endpoint. OAuth tokens must name it as their audience,
 * and discovery metadata advertises it. Local development sets
 * FITNESS_MCP_URL, for example http://127.0.0.1:3025/api/mcp.
 */
export function mcpResource() {
  const value =
    process.env.FITNESS_MCP_URL?.trim() || "https://fitness.bent.build/api/mcp";
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const secure =
      url.protocol === "https:" || (local && url.protocol === "http:");
    return secure &&
      url.pathname === "/api/mcp" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
