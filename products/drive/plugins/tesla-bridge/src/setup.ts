import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  defaultTeslaConfigDirectory,
  defaultTeslaTokenFile,
  loadTeslaEnvironment,
} from "./config.js";
import { TeslaTokenStore } from "./token-store.js";

const setupEnvironmentSchema = z.object({
  TESLA_APP_DOMAIN: z.string().min(1),
  TESLA_REDIRECT_URI: z.string().url(),
  TESLA_FLEET_API_BASE_URL: z.string().url(),
  TESLA_SCOPES: z.string().min(1),
  TESLA_CLIENT_ID: z.string().min(1),
  TESLA_CLIENT_SECRET: z.string().min(1),
  TESLA_TOKEN_FILE: z.string().min(1).optional(),
  TESLA_TOKEN_ENDPOINT: z
    .string()
    .url()
    .default("https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token"),
});

const partnerTokenSchema = z.object({ access_token: z.string().min(1) });
const oauthStateSchema = z.object({
  state: z.string().min(32),
  nonce: z.string().min(32),
  createdAt: z.string().datetime(),
  redirectUri: z.string().url(),
  scopes: z.string().min(1),
});
const callbackFileSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
const vehiclesResponseSchema = z.object({
  response: z.array(
    z.object({
      display_name: z.string().nullable().optional(),
      state: z.string().optional(),
    })
  ),
});

type SetupConfig = z.infer<typeof setupEnvironmentSchema>;

const command = process.argv[2];

try {
  const config = setupEnvironmentSchema.parse(loadTeslaEnvironment());
  switch (command) {
    case undefined:
      throw new Error("Usage: setup <register|authorize-url|exchange-code --code-file PATH|check>");
    case "register":
      await registerPartner(config);
      break;
    case "authorize-url":
      await printAuthorizationUrl(config);
      break;
    case "exchange-code":
      await exchangeAuthorizationCode(config, requireOption("--code-file"));
      break;
    case "check":
      await checkConnection(config);
      break;
    default:
      throw new Error("Usage: setup <register|authorize-url|exchange-code --code-file PATH|check>");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Tesla setup failed.";
  console.error(message);
  process.exitCode = 1;
}

async function registerPartner(config: SetupConfig): Promise<void> {
  const partnerToken = await createPartnerToken(config);
  if (await publicKeyIsRegistered(config, partnerToken)) {
    console.log(`Partner account already registered for ${config.TESLA_APP_DOMAIN}.`);
    return;
  }

  const response = await fetch(new URL("/api/1/partner_accounts", config.TESLA_FLEET_API_BASE_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${partnerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ domain: config.TESLA_APP_DOMAIN }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Tesla partner registration failed with HTTP ${response.status}.`);
  }
  if (!(await publicKeyIsRegistered(config, partnerToken))) {
    throw new Error("Tesla did not return the registered public key after registration.");
  }
  console.log(`Partner account registered for ${config.TESLA_APP_DOMAIN}.`);
}

async function createPartnerToken(config: SetupConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.TESLA_CLIENT_ID,
    client_secret: config.TESLA_CLIENT_SECRET,
    audience: config.TESLA_FLEET_API_BASE_URL,
    scope: "openid vehicle_device_data",
  });
  const response = await fetch(config.TESLA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const responseBody: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Tesla partner-token request failed with HTTP ${response.status}.`);
  }
  return partnerTokenSchema.parse(responseBody).access_token;
}

async function publicKeyIsRegistered(config: SetupConfig, partnerToken: string): Promise<boolean> {
  const url = new URL("/api/1/partner_accounts/public_key", config.TESLA_FLEET_API_BASE_URL);
  url.searchParams.set("domain", config.TESLA_APP_DOMAIN);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${partnerToken}` },
  });
  return response.ok;
}

async function printAuthorizationUrl(config: SetupConfig): Promise<void> {
  const state = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const stateFile = oauthStateFile();
  const pending = oauthStateSchema.parse({
    state,
    nonce,
    createdAt: new Date().toISOString(),
    redirectUri: config.TESLA_REDIRECT_URI,
    scopes: config.TESLA_SCOPES,
  });
  await writePrivateJson(stateFile, pending);

  const url = new URL("https://auth.tesla.com/oauth2/v3/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.TESLA_CLIENT_ID,
    redirect_uri: config.TESLA_REDIRECT_URI,
    scope: config.TESLA_SCOPES,
    state,
    nonce,
    locale: "en-AU",
    prompt_missing_scopes: "true",
    require_requested_scopes: "true",
  }).toString();
  console.log(url.toString());
}

async function exchangeAuthorizationCode(config: SetupConfig, codeFile: string): Promise<void> {
  const pending = oauthStateSchema.parse(JSON.parse(await readFile(oauthStateFile(), "utf8")));
  const callback = callbackFileSchema.parse(JSON.parse(await readFile(codeFile, "utf8")));
  if (callback.state !== pending.state) {
    throw new Error("Tesla OAuth state did not match the pending authorization request.");
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.TESLA_CLIENT_ID,
      client_secret: config.TESLA_CLIENT_SECRET,
      code: callback.code,
      audience: config.TESLA_FLEET_API_BASE_URL,
      redirect_uri: pending.redirectUri,
      scope: pending.scopes,
    });
    const response = await fetch(config.TESLA_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const responseBody: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`Tesla authorization-code exchange failed with HTTP ${response.status}.`);
    }
    const tokenFile = config.TESLA_TOKEN_FILE ?? defaultTeslaTokenFile();
    await new TeslaTokenStore(tokenFile, config.TESLA_TOKEN_ENDPOINT).saveResponse(responseBody);
    console.log(`Tesla OAuth tokens stored securely at ${tokenFile}.`);
  } finally {
    await unlink(codeFile).catch(() => undefined);
  }
}

async function checkConnection(config: SetupConfig): Promise<void> {
  const tokenFile = config.TESLA_TOKEN_FILE ?? defaultTeslaTokenFile();
  const accessToken = await new TeslaTokenStore(tokenFile, config.TESLA_TOKEN_ENDPOINT).getAccessToken(
    config.TESLA_CLIENT_ID
  );
  const response = await fetch(new URL("/api/1/vehicles", config.TESLA_FLEET_API_BASE_URL), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const responseBody: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Tesla vehicle check failed with HTTP ${response.status}.`);
  }
  const vehicles = vehiclesResponseSchema.parse(responseBody).response;
  console.log(`Connected to ${vehicles.length} vehicle(s).`);
  for (const vehicle of vehicles) {
    console.log(`- ${vehicle.display_name ?? "Unnamed vehicle"}: ${vehicle.state ?? "unknown"}`);
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function oauthStateFile(): string {
  return join(defaultTeslaConfigDirectory(), "oauth-state.json");
}

function requireOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
