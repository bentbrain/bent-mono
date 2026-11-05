import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { z } from "zod";

const booleanStringSchema = z.enum(["true", "false"]);

const environmentSchema = z.object({
  TESLA_MODE: z.enum(["auto", "mock", "live"]).default("auto"),
  TESLA_ACTIONS_ENABLED: booleanStringSchema.optional(),
  TESLA_ACCESS_TOKEN: z.string().min(1).optional(),
  TESLA_CLIENT_ID: z.string().min(1).optional(),
  TESLA_TOKEN_FILE: z.string().min(1).optional(),
  TESLA_TOKEN_ENDPOINT: z
    .string()
    .url()
    .default("https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token"),
  TESLA_FLEET_API_BASE_URL: z.string().url().default("https://fleet-api.prd.na.vn.cloud.tesla.com"),
  TESLA_COMMAND_PROXY_URL: z.string().url().optional(),
  TESLA_BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});

export type TeslaBridgeConfig = {
  mode: "mock" | "live";
  actionsEnabled: boolean;
  accessToken: string | undefined;
  clientId: string | undefined;
  tokenFile: string;
  tokenEndpoint: string;
  fleetApiBaseUrl: string;
  commandProxyUrl: string | undefined;
  port: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): TeslaBridgeConfig {
  const resolvedEnvironment = environment === process.env ? loadTeslaEnvironment(environment) : environment;
  const parsed = environmentSchema.parse(resolvedEnvironment);
  const tokenFile = parsed.TESLA_TOKEN_FILE ?? defaultTeslaTokenFile();
  const mode =
    parsed.TESLA_MODE === "auto"
      ? parsed.TESLA_ACCESS_TOKEN || (parsed.TESLA_CLIENT_ID && existsSync(tokenFile))
        ? "live"
        : "mock"
      : parsed.TESLA_MODE;
  const actionsEnabled = parsed.TESLA_ACTIONS_ENABLED
    ? parsed.TESLA_ACTIONS_ENABLED === "true"
    : mode === "mock";

  return {
    mode,
    actionsEnabled,
    accessToken: parsed.TESLA_ACCESS_TOKEN,
    clientId: parsed.TESLA_CLIENT_ID,
    tokenFile,
    tokenEndpoint: parsed.TESLA_TOKEN_ENDPOINT,
    fleetApiBaseUrl: parsed.TESLA_FLEET_API_BASE_URL,
    commandProxyUrl: parsed.TESLA_COMMAND_PROXY_URL,
    port: parsed.TESLA_BRIDGE_PORT,
  };
}

export function defaultTeslaConfigDirectory(): string {
  return join(homedir(), ".config", "tesla-bridge");
}

function defaultTeslaConfigFile(): string {
  return join(defaultTeslaConfigDirectory(), "tesla.env");
}

export function defaultTeslaTokenFile(): string {
  return join(defaultTeslaConfigDirectory(), "tokens.json");
}

export function loadTeslaEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const configFile = environment.TESLA_CONFIG_FILE ?? defaultTeslaConfigFile();
  if (!existsSync(configFile)) {
    return environment;
  }

  return {
    ...parseEnv(readFileSync(configFile, "utf8")),
    ...environment,
  };
}
