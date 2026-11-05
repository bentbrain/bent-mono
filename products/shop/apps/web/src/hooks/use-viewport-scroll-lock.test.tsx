// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useViewportScrollLock } from "@/hooks/use-viewport-scroll-lock";

function ScrollLockHarness({ locked }: { locked: boolean }) {
  useViewportScrollLock(locked);
  return null;
}

describe("useViewportScrollLock", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  it("locks page scrolling and restores the previous inline styles", () => {
    document.documentElement.style.overflow = "auto";
    document.body.style.position = "relative";
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(<ScrollLockHarness locked />);
    });

    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overscrollBehavior).toBe("none");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.position).toBe("fixed");
    expect(document.body.style.width).toBe("100%");

    act(() => {
      root.unmount();
    });

    expect(document.documentElement.style.overflow).toBe("auto");
    expect(document.documentElement.style.overscrollBehavior).toBe("");
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.position).toBe("relative");
    expect(document.body.style.width).toBe("");
  });
});
