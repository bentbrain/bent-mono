export interface IntegrationEnv {
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
  readonly CART_LINE_CAPABILITY_SECRET?: string;
  readonly OPENAI_API_KEY?: string;
  readonly PRINTIFY_API_TOKEN?: string;
  readonly PRINTIFY_ASSET_DELIVERY_SECRET?: string;
  readonly PRINTIFY_ASSET_ORIGIN?: string;
  readonly PRINTIFY_WEBHOOK_SECRET?: string;
  readonly PRINTIFY_SHOP_ID?: string;
  readonly SCHEDULED_TASK_SECRET?: string;
  readonly SHOPIFY_CLIENT_ID?: string;
  readonly SHOPIFY_CLIENT_SECRET?: string;
  readonly SHOPIFY_ADMIN_STORE_DOMAIN?: string;
}

export class IntegrationConfigError extends Error {
  readonly integration: string;
  readonly missing: readonly string[];

  constructor(integration: string, missing: readonly string[]) {
    super(
      `${integration} configuration is missing: ${missing.join(", ")}.`,
    );
    this.name = "IntegrationConfigError";
    this.integration = integration;
    this.missing = missing;
  }
}

export function requirePrintifyConfig(env: IntegrationEnv) {
  const apiToken = configuredValue(env.PRINTIFY_API_TOKEN);
  const shopId = configuredValue(env.PRINTIFY_SHOP_ID);
  requireValues("Printify", [
    ["PRINTIFY_API_TOKEN", apiToken],
    ["PRINTIFY_SHOP_ID", shopId],
  ]);
  if (!apiToken || !shopId) throw unreachableConfigurationError();
  return { apiToken, shopId };
}

export function requirePrintifyProductionConfig(env: IntegrationEnv) {
  const printify = requirePrintifyConfig(env);
  const assetDeliverySecret = configuredValue(
    env.PRINTIFY_ASSET_DELIVERY_SECRET,
  );
  const assetOrigin = configuredValue(env.PRINTIFY_ASSET_ORIGIN);
  requireValues("Printify production", [
    ["PRINTIFY_ASSET_DELIVERY_SECRET", assetDeliverySecret],
    ["PRINTIFY_ASSET_ORIGIN", assetOrigin],
  ]);
  if (!assetDeliverySecret || assetDeliverySecret.length < 32) {
    throw new IntegrationConfigError("Printify production", [
      "PRINTIFY_ASSET_DELIVERY_SECRET (minimum 32 characters)",
    ]);
  }
  if (!assetOrigin || !validAssetOrigin(assetOrigin)) {
    throw new IntegrationConfigError("Printify production", [
      "PRINTIFY_ASSET_ORIGIN (expected an HTTPS origin or local HTTP origin)",
    ]);
  }
  return {
    ...printify,
    assetDeliverySecret,
    assetOrigin: new URL(assetOrigin).origin,
  };
}

export function requirePrintifyWebhookConfig(env: IntegrationEnv) {
  const printify = requirePrintifyConfig(env);
  const webhookSecret = configuredValue(env.PRINTIFY_WEBHOOK_SECRET);
  requireValues("Printify webhooks", [
    ["PRINTIFY_WEBHOOK_SECRET", webhookSecret],
  ]);
  if (!webhookSecret || webhookSecret.length < 32) {
    throw new IntegrationConfigError("Printify webhooks", [
      "PRINTIFY_WEBHOOK_SECRET (minimum 32 characters)",
    ]);
  }
  return { ...printify, webhookSecret };
}

export function requireOpenAiConfig(env: IntegrationEnv) {
  const apiKey = configuredValue(env.OPENAI_API_KEY);
  requireValues("OpenAI", [["OPENAI_API_KEY", apiKey]]);
  if (!apiKey) throw unreachableConfigurationError();
  return { apiKey };
}

export function requireShopifyAdminConfig(env: IntegrationEnv) {
  const clientId = configuredValue(env.SHOPIFY_CLIENT_ID);
  const clientSecret = configuredValue(env.SHOPIFY_CLIENT_SECRET);
  const storeDomain = configuredValue(env.SHOPIFY_ADMIN_STORE_DOMAIN);
  requireValues("Shopify Admin", [
    ["SHOPIFY_CLIENT_ID", clientId],
    ["SHOPIFY_CLIENT_SECRET", clientSecret],
    ["SHOPIFY_ADMIN_STORE_DOMAIN", storeDomain],
  ]);
  if (!clientId || !clientSecret || !storeDomain) {
    throw unreachableConfigurationError();
  }
  validateShopifyStoreDomain(storeDomain);
  return { clientId, clientSecret, storeDomain };
}

export function requireShopifyAdminClientConfig(env: IntegrationEnv) {
  const clientId = configuredValue(env.SHOPIFY_CLIENT_ID);
  const clientSecret = configuredValue(env.SHOPIFY_CLIENT_SECRET);
  const storeDomain = configuredValue(env.SHOPIFY_ADMIN_STORE_DOMAIN);
  requireValues("Shopify Admin", [
    ["SHOPIFY_CLIENT_ID", clientId],
    ["SHOPIFY_CLIENT_SECRET", clientSecret],
    ["SHOPIFY_ADMIN_STORE_DOMAIN", storeDomain],
  ]);
  if (!clientId || !clientSecret || !storeDomain) {
    throw unreachableConfigurationError();
  }
  validateShopifyStoreDomain(storeDomain);
  return { clientId, clientSecret, storeDomain };
}

export function requireShopifyWebhookConfig(env: IntegrationEnv) {
  const clientSecret = configuredValue(env.SHOPIFY_CLIENT_SECRET);
  const storeDomain = configuredValue(env.SHOPIFY_ADMIN_STORE_DOMAIN);
  requireValues("Shopify webhooks", [
    ["SHOPIFY_CLIENT_SECRET", clientSecret],
  ]);
  if (!clientSecret) throw unreachableConfigurationError();
  if (storeDomain) validateShopifyStoreDomain(storeDomain);
  return { clientSecret, storeDomain };
}

export function requireCartLineCapabilityConfig(env: IntegrationEnv) {
  const secret = configuredValue(env.CART_LINE_CAPABILITY_SECRET);
  requireValues("cart-line capabilities", [
    ["CART_LINE_CAPABILITY_SECRET", secret],
  ]);
  if (!secret || secret.length < 32) {
    throw new IntegrationConfigError("cart-line capabilities", [
      "CART_LINE_CAPABILITY_SECRET (minimum 32 characters)",
    ]);
  }
  return { secret };
}

function validateShopifyStoreDomain(storeDomain: string) {
  if (!isShopifyStoreDomain(storeDomain)) {
    throw new IntegrationConfigError("Shopify Admin", [
      "SHOPIFY_ADMIN_STORE_DOMAIN (expected a .myshopify.com hostname)",
    ]);
  }
}

export function requireScheduledTaskConfig(env: IntegrationEnv) {
  const secret = configuredValue(env.SCHEDULED_TASK_SECRET);
  requireValues("scheduled tasks", [["SCHEDULED_TASK_SECRET", secret]]);
  if (!secret) throw unreachableConfigurationError();
  return { secret };
}

export function requireOperationsConfig(env: IntegrationEnv) {
  const secret = configuredValue(env.BENT_SHIRT_OPERATIONS_SECRET);
  requireValues("operations", [["BENT_SHIRT_OPERATIONS_SECRET", secret]]);
  if (!secret) throw unreachableConfigurationError();
  return { secret };
}

function configuredValue(value: string | undefined) {
  const configured = value?.trim();
  if (!configured) return undefined;
  return configured;
}

function requireValues(
  integration: string,
  values: readonly (readonly [name: string, value: string | undefined])[],
) {
  const missing = values
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) throw new IntegrationConfigError(integration, missing);
}

function isShopifyStoreDomain(value: string) {
  if (value.includes(":") || value.includes("/")) return false;
  return value.endsWith(".myshopify.com") && value.length > ".myshopify.com".length;
}

function validAssetOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash) return false;
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
  } catch {
    return false;
  }
}

function unreachableConfigurationError() {
  return new Error("Configuration validation returned an invalid result.");
}
