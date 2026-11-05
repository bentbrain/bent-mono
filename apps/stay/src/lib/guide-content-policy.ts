export function isGuideFixtureEnvironment(environment: {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
}) {
  return (
    environment.VERCEL_ENV === "preview" ||
    (environment.NODE_ENV !== "production" &&
      environment.VERCEL_ENV !== "production")
  );
}

// Legacy CMS documents can contain the former configured network link.
// Keep its value server-side and replace only an exact match with the auth route.
export function normalizeGuideLinks(
  value: unknown,
  legacyUrl?: string,
): unknown {
  if (!legacyUrl) return value;
  if (typeof value === "string")
    return value === legacyUrl ? "/home-controls" : value;
  if (Array.isArray(value))
    return value.map((item: unknown) => normalizeGuideLinks(item, legacyUrl));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeGuideLinks(item, legacyUrl),
      ]),
    );
  return value;
}
