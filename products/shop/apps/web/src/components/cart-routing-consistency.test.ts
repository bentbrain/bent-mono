import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("cart routing", () => {
  it("keeps the drawer in the shared app shell without a parallel route", async () => {
    const [appShell, cartProvider, rootLayout, cartSlotExists] = await Promise.all([
      readFile(new URL("../app/app-shell.tsx", import.meta.url), "utf8"),
      readFile(
        new URL("./cart-store-provider.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      access(new URL("../app/@cart/(.)cart/page.tsx", import.meta.url)).then(
        () => true,
        () => false,
      ),
    ]);

    expect(cartSlotExists).toBe(false);
    expect(rootLayout).not.toContain("cart:");
    expect(cartProvider).toContain("<CartDrawer />");
    expect(cartProvider).not.toContain('dynamic(');
    expect(appShell).not.toContain("cart={cart}");
  });
});
