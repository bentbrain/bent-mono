import { describe, expect, it, vi } from "vitest";

import { configureStandardOpenCart } from "@/lib/configure-standard-open-cart";

class OpenCartAction {
  configuredHandler: (() => Promise<void>) | undefined;

  configure(options: { handler: () => Promise<void> }) {
    this.configuredHandler = options.handler;
  }
}

describe("configureStandardOpenCart", () => {
  it("waits until Shopify exposes the complete open-cart action", () => {
    const open = vi.fn();

    expect(configureStandardOpenCart(undefined, open)).toBe(false);
    expect(configureStandardOpenCart({ actions: {} }, open)).toBe(false);
    expect(
      configureStandardOpenCart({ actions: { openCart: {} } }, open),
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("configures the standard action to use the storefront overlay", async () => {
    const openCart = new OpenCartAction();
    const open = vi.fn();

    expect(
      configureStandardOpenCart({ actions: { openCart } }, open),
    ).toBe(true);

    await openCart.configuredHandler?.();

    expect(open).toHaveBeenCalledOnce();
  });
});
