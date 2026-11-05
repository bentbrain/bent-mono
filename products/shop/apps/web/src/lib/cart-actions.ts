import type { ShopifyGlobal } from "@shopify/hydrogen";

export async function waitForCartActions(): Promise<ShopifyGlobal["actions"]> {
  const timeoutAt = Date.now() + 5_000;
  while (Date.now() < timeoutAt) {
    if (
      window.Shopify?.actions.updateCart &&
      !window.Shopify.actions.updateCart.isDefault()
    ) {
      return window.Shopify.actions;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("The cart is still loading. Please try again.");
}
