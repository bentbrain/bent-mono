/**
 * Build variants. Each has its own bundle ID and OAuth redirect URI. The
 * production variant always talks to fitness.bent.build. A development build
 * can point at a local Fitness server with FITNESS_ORIGIN.
 */
export type Variant = "development" | "production";

const productionOrigin = "https://fitness.bent.build";

const variants = {
  development: {
    name: "Fitness Sync Dev",
    bundleIdentifier: "build.bent.fitness.dev",
  },
  production: {
    name: "Fitness Sync",
    bundleIdentifier: "build.bent.fitness",
  },
} as const;

export function resolveVariant(value: string | undefined): Variant {
  if (value === undefined || value === "" || value === "production") return "production";
  if (value === "development") return "development";
  throw new Error("Set APP_VARIANT to development or production.");
}

/** An origin a development build may use: HTTPS, or HTTP on this Mac. */
export function developmentOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Set FITNESS_ORIGIN to an origin such as https://fitness.bent.build.");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("FITNESS_ORIGIN must use HTTPS, or HTTP on 127.0.0.1 or localhost.");
  if (url.origin !== value.replace(/\/$/, "")) throw new Error("Set FITNESS_ORIGIN to an origin, without a path.");
  return { origin: url.origin, local };
}

type OAuthSettings = {
  /** Clerk's OAuth issuer, such as https://clerk.example.com, or "" when unset. */
  issuer: string;
  /** The public OAuth application's client ID, or "" when unset. */
  clientId: string;
  redirectUri: string;
  /** The audience the enrollment token is issued for. */
  resource: string;
  scopes: readonly string[];
};

export type AppSettings = {
  name: string;
  bundleIdentifier: string;
  scheme: string;
  fitnessOrigin: string;
  allowLocalNetworking: boolean;
  oauth: OAuthSettings;
};

/** Clerk's issuer: HTTPS, or HTTP on this Mac for a development build. */
function issuerFrom(variant: Variant, value: string | undefined) {
  if (!value) return "";
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(variant === "development" && url.protocol === "http:" && local))
    throw new Error("FITNESS_OAUTH_ISSUER must use HTTPS.");
  return url.href.replace(/\/$/, "");
}

/**
 * The settings for a variant. FITNESS_OAUTH_ISSUER and
 * FITNESS_OAUTH_CLIENT_ID are public values for the Clerk instance and its
 * "Fitness Sync iOS" application. Without them the app explains that sign-in
 * is not configured in this build.
 */
export function appSettings(variant: Variant, environment: Record<string, string | undefined>): AppSettings {
  const base = variants[variant];
  let fitnessOrigin = productionOrigin;
  // Development builds load JavaScript from Metro on this Mac.
  let allowLocalNetworking = variant === "development";
  if (variant === "development" && environment.FITNESS_ORIGIN) {
    const chosen = developmentOrigin(environment.FITNESS_ORIGIN);
    fitnessOrigin = chosen.origin;
    allowLocalNetworking = true;
  } else if (variant === "production" && environment.FITNESS_ORIGIN)
    throw new Error("Production builds always use https://fitness.bent.build.");
  const scheme = base.bundleIdentifier;
  return {
    name: base.name,
    bundleIdentifier: base.bundleIdentifier,
    scheme,
    fitnessOrigin,
    allowLocalNetworking,
    oauth: {
      issuer: issuerFrom(variant, environment.FITNESS_OAUTH_ISSUER?.trim()),
      clientId: environment.FITNESS_OAUTH_CLIENT_ID?.trim() ?? "",
      redirectUri: `${scheme}://oauth`,
      resource: `${fitnessOrigin}/api/mcp`,
      scopes: ["fitness:health:enroll", "openid"],
    },
  };
}
