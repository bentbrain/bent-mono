// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { CartChromeStoreProvider } from "@/components/cart-store-provider";

describe("CartChromeStoreProvider", () => {
  it("renders drawer consumers inside the header cart provider", () => {
    const html = renderToStaticMarkup(
      <CartChromeStoreProvider cartData={{ cart: null }} />,
    );

    expect(html).toContain('href="/cart"');
    expect(html).toContain("cart");
  });
});
