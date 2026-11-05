import { Config, Context, Effect, Layer, Redacted } from "effect";

export interface AppConfig {
  appUrl: string;
  mcpResource: string;
  protectedResourceMetadataUrl: string;
  databaseUrl: Redacted.Redacted<string>;
  tokenEncryptionKey: Redacted.Redacted<string>;
  teslaClientId: string;
  teslaClientSecret: Redacted.Redacted<string>;
  teslaRedirectUri: string;
  teslaAuthorizationEndpoint: string;
  teslaTokenEndpoint: string;
  teslaFleetApiBaseUrl: string;
  teslaScopes: string;
  adminGithubUsers: readonly string[];
  allowedGithubUsers: readonly string[];
  allowLocalOAuthRedirects: boolean;
  mcpAccessTokenTtlSeconds: number;
  mcpRefreshTokenTtlSeconds: number;
}

export class AppConfigService extends Context.Tag("@bent-drive/AppConfig")<
  AppConfigService,
  AppConfig
>() {}

const rawConfig = Config.all({
  appUrl: Config.string("APP_URL"),
  databaseUrl: Config.redacted("DATABASE_URL"),
  tokenEncryptionKey: Config.redacted("TOKEN_ENCRYPTION_KEY"),
  teslaClientId: Config.string("TESLA_CLIENT_ID"),
  teslaClientSecret: Config.redacted("TESLA_CLIENT_SECRET"),
  teslaRedirectUri: Config.string("TESLA_REDIRECT_URI"),
  teslaAuthorizationEndpoint: Config.string("TESLA_AUTHORIZATION_ENDPOINT").pipe(
    Config.withDefault("https://auth.tesla.com/oauth2/v3/authorize")
  ),
  teslaTokenEndpoint: Config.string("TESLA_TOKEN_ENDPOINT").pipe(
    Config.withDefault("https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token")
  ),
  teslaFleetApiBaseUrl: Config.string("TESLA_FLEET_API_BASE_URL").pipe(
    Config.withDefault("https://fleet-api.prd.na.vn.cloud.tesla.com")
  ),
  teslaScopes: Config.string("TESLA_SCOPES").pipe(
    Config.withDefault("openid offline_access vehicle_device_data")
  ),
  adminGithubUsers: Config.string("BENT_DRIVE_ADMIN_GITHUB_USERS"),
  allowedGithubUsers: Config.string("BENT_DRIVE_ALLOWED_GITHUB_USERS"),
  allowLocalOAuthRedirects: Config.boolean("ALLOW_LOCAL_OAUTH_REDIRECTS").pipe(
    Config.withDefault(false)
  ),
  mcpAccessTokenTtlSeconds: Config.integer("MCP_ACCESS_TOKEN_TTL_SECONDS").pipe(
    Config.withDefault(3_600)
  ),
  mcpRefreshTokenTtlDays: Config.integer("MCP_REFRESH_TOKEN_TTL_DAYS").pipe(
    Config.withDefault(90)
  ),
});

const loadAppConfig = rawConfig.pipe(
  Effect.map((config) => {
    const appUrl = config.appUrl.replace(/\/$/, "");
    const adminGithubUsers = parseGithubUserList(config.adminGithubUsers);
    const allowedGithubUsers = Array.from(
      new Set([...parseGithubUserList(config.allowedGithubUsers), ...adminGithubUsers])
    );
    return {
      appUrl,
      mcpResource: `${appUrl}/mcp`,
      protectedResourceMetadataUrl: `${appUrl}/.well-known/oauth-protected-resource/mcp`,
      databaseUrl: strictTlsDatabaseUrl(config.databaseUrl),
      tokenEncryptionKey: config.tokenEncryptionKey,
      teslaClientId: config.teslaClientId,
      teslaClientSecret: config.teslaClientSecret,
      teslaRedirectUri: config.teslaRedirectUri,
      teslaAuthorizationEndpoint: config.teslaAuthorizationEndpoint,
      teslaTokenEndpoint: config.teslaTokenEndpoint,
      teslaFleetApiBaseUrl: config.teslaFleetApiBaseUrl,
      teslaScopes: config.teslaScopes,
      adminGithubUsers,
      allowedGithubUsers,
      allowLocalOAuthRedirects: config.allowLocalOAuthRedirects,
      mcpAccessTokenTtlSeconds: config.mcpAccessTokenTtlSeconds,
      mcpRefreshTokenTtlSeconds: config.mcpRefreshTokenTtlDays * 24 * 60 * 60,
    };
  }),
  Effect.withSpan("config.load")
);

export const AppConfigLive = Layer.effect(AppConfigService, loadAppConfig);

export function reveal(value: Redacted.Redacted<string>): string {
  return Redacted.value(value);
}

function strictTlsDatabaseUrl(value: Redacted.Redacted<string>): Redacted.Redacted<string> {
  const url = new URL(Redacted.value(value));
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode === "prefer" || sslMode === "require" || sslMode === "verify-ca") {
    url.searchParams.set("sslmode", "verify-full");
  }
  return Redacted.make(url.toString());
}

function normalizeGithubUsername(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase();
}

function parseGithubUserList(value: string): string[] {
  return value
    .split(",")
    .map((username) => normalizeGithubUsername(username))
    .filter((username) => username.length > 0);
}
