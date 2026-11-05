// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CartGarmentMockup } from "@/components/cart-garment-mockup";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CartGarmentMockup", () => {
  it("retries a pending thumbnail and cancels retries when removed", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => { root.render(<CartGarmentMockup color="White" productId="product-1" sizes="220px" title="bent.shop" />); });
    const image = container.querySelector("img");
    act(() => { image?.dispatchEvent(new Event("error")); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(container.querySelector("img")?.getAttribute("src")).toContain("&retry=1");
    act(() => { container.querySelector("img")?.dispatchEvent(new Event("error")); });
    act(() => { root.unmount(); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the configured product image at thumbnail resolution so saved placement remains canonical", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CartGarmentMockup
          color="White"
          productId="product-1"
          sizes="220px"
          title="bent.shop"
        />,
      );
    });

    expect(container.querySelector("img")?.src).toBe(
      "http://localhost:3000/api/configured-product-image/current/product-1/white.webp?geometry=physical-print-area-v1&access=revocable-v1&width=384",
    );

    act(() => {
      root.unmount();
    });
  });
});
