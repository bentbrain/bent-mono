// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CartDrawer } from "@/components/cart-drawer";
import { CartProvider } from "@/lib/cart";
import { CART_TRIGGER_ID, openCartDrawer } from "@/lib/cart-drawer";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("CartDrawer", () => {
  it("retains an open request made before the shell mounts", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    openCartDrawer();
    act(() => { root.render(<CartProvider initialData={{ cart: null }}><CartDrawer /></CartProvider>); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => { root.unmount(); });
  });

  it("opens and closes without route state", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.id = CART_TRIGGER_ID;
    const focusTrigger = vi.spyOn(trigger, "focus");
    document.body.append(container);
    document.body.append(trigger);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CartProvider initialData={{ cart: null }}>
          <CartDrawer />
        </CartProvider>,
      );
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    trigger.focus();
    act(() => {
      openCartDrawer();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="dialog-header"]')).toBeNull();
    const close = document.querySelector<HTMLButtonElement>(
      '[data-slot="dialog-close"]',
    );
    if (!close) throw new Error("Expected the cart dialog close control.");

    await act(async () => {
      close.click();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(focusTrigger).toHaveBeenLastCalledWith({ preventScroll: true });

    act(() => {
      root.unmount();
    });
  });

  it("uses one toolbar-safe dialog without a mobile drawer", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CartProvider initialData={{ cart: null }}>
          <CartDrawer />
        </CartProvider>,
      );
    });
    act(() => {
      openCartDrawer();
    });

    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Expected the mobile cart dialog.");
    }
    expect(dialog.className).toContain(
      "max-h-[min(760px,calc(100svh-6rem))]",
    );
    expect(dialog.style.top).toBe("calc(50% + 1.5rem)");
    expect(dialog.style.maxWidth).toBe("680px");
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="drawer-popup"]')).toBeNull();
    expect(
      document.querySelector(
        '[data-slot="dialog-close"][aria-label="Close cart"]',
      ),
    ).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });
});
