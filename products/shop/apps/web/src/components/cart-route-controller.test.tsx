// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  openDrawer: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/lib/configure-standard-open-cart", () => ({
  configureStandardOpenCart: mocks.configure,
}));

vi.mock("@/lib/cart-drawer", () => ({
  openCartDrawer: mocks.openDrawer,
}));

import { CartRouteController } from "@/components/cart-route-controller";

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("CartRouteController", () => {
  it("opens the shared drawer without navigating", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.configure.mockImplementation((_shopify, handler: () => void) => {
      handler();
      return true;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<CartRouteController />);
      await Promise.resolve();
    });

    expect(mocks.openDrawer).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
