import { describe, expect, it } from "vitest";

import {
  IntegrationConfigError,
  requireCartLineCapabilityConfig,
  requireOpenAiConfig,
  requireOperationsConfig,
  requirePrintifyConfig,
  requireScheduledTaskConfig,
  requireShopifyAdminConfig,
  requireShopifyWebhookConfig,
} from "./integration-config";

describe("integration configuration", () => {
  it("returns named Printify configuration", () => {
    expect(requirePrintifyConfig({
      PRINTIFY_API_TOKEN: " token ",
      PRINTIFY_SHOP_ID: "shop-1",
    })).toEqual({ apiToken: "token", shopId: "shop-1" });
  });

  it("reports every missing Shopify Admin value", () => {
    expect(() => requireShopifyAdminConfig({})).toThrow(
      new IntegrationConfigError("Shopify Admin", [
        "SHOPIFY_CLIENT_ID",
        "SHOPIFY_CLIENT_SECRET",
        "SHOPIFY_ADMIN_STORE_DOMAIN",
      ]),
    );
  });

  it("rejects a storefront URL where a Shopify hostname is required", () => {
    expect(() => requireShopifyAdminConfig({
      SHOPIFY_CLIENT_ID: "client-id",
      SHOPIFY_CLIENT_SECRET: "client-secret",
      SHOPIFY_ADMIN_STORE_DOMAIN: "https://shop.myshopify.com",
    })).toThrow("expected a .myshopify.com hostname");
  });

  it("uses the Shopify client secret for webhook verification", () => {
    expect(requireShopifyWebhookConfig({
      SHOPIFY_ADMIN_STORE_DOMAIN: "bent-shirt.myshopify.com",
      SHOPIFY_CLIENT_SECRET: " client-secret ",
    })).toEqual({
      clientSecret: "client-secret",
      storeDomain: "bent-shirt.myshopify.com",
    });
  });

  it("keeps each remaining secret boundary independent", () => {
    expect(requireCartLineCapabilityConfig({
      CART_LINE_CAPABILITY_SECRET: "c".repeat(32),
    })).toEqual({ secret: "c".repeat(32) });
    expect(requireOpenAiConfig({ OPENAI_API_KEY: "openai" }))
      .toEqual({ apiKey: "openai" });
    expect(requireScheduledTaskConfig({ SCHEDULED_TASK_SECRET: "schedule" }))
      .toEqual({ secret: "schedule" });
    expect(requireOperationsConfig({ BENT_SHIRT_OPERATIONS_SECRET: "ops" }))
      .toEqual({ secret: "ops" });
  });

  it("requires a cryptographically strong cart-line secret", () => {
    expect(() => requireCartLineCapabilityConfig({
      CART_LINE_CAPABILITY_SECRET: "too-short",
    })).toThrow("minimum 32 characters");
  });
});
