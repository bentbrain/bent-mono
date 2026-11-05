// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  currentProductUrl,
  ProductShare,
} from "@/components/product-share";

describe("ProductShare", () => {
  it("keeps link sharing available while product media is prepared", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <ProductShare />,
    );

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy product link");
    expect(button?.textContent).toBe("");
    expect(button?.querySelector("svg")).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(button?.hasAttribute("aria-busy")).toBe(false);
  });

  it("reads the latest variant URL when sharing", () => {
    window.history.replaceState(
      null,
      "",
      "/product/base-product?Color=Black&Size=S",
    );
    expect(currentProductUrl()).toContain("Color=Black&Size=S");

    window.history.replaceState(
      null,
      "",
      "/product/base-product?Color=White&Size=M",
    );
    expect(currentProductUrl()).toBe(
      `${window.location.origin}/product/base-product?Color=White&Size=M`,
    );
  });

  it("copies the latest URL with query parameters and confirms it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writeText = vi.fn(() => Promise.resolve());
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    window.history.replaceState(
      null,
      "",
      "/product/base-product?Color=White&Size=M&utm_content=reel_01",
    );

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(<ProductShare />);
      });
      const button = container.querySelector<HTMLButtonElement>("button");
      expect(button).not.toBeNull();

      await act(async () => {
        button?.click();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/product/base-product?Color=White&Size=M&utm_content=reel_01`,
      );
      expect(button?.getAttribute("aria-label")).toBe("Product link copied");
      expect(button?.querySelector('svg[data-copy-icon="check"]')).not.toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Copied");

      act(() => {
        vi.advanceTimersByTime(1_600);
      });
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(button?.getAttribute("aria-label")).toBe("Copy product link");
      expect(button?.querySelector('svg[data-copy-icon="link"]')).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
