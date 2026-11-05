// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileOnlyGate } from "@/components/mobile-only-gate";

// Happy DOM has no canvas context. Browser tests exercise the actual QR renderer.
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn(() => Promise.resolve()) } }));

function installMatchMedia(matches: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let currentMatches = matches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return currentMatches;
    },
    media: "(min-width: 1024px)",
    onchange: null,
    addEventListener(
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) {
      listeners.add(listener);
    },
    removeEventListener(
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    setMatches(nextMatches: boolean) {
      currentMatches = nextMatches;
      const event = new MediaQueryListEvent("change", {
        matches: nextMatches,
        media: query.media,
      });
      listeners.forEach((listener) => {
        listener(event);
      });
    },
  };
}

afterEach(async () => {
  // Finish lazy QR imports while this file still owns its mock and DOM.
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("MobileOnlyGate", () => {
  it("does not mount camera work or expose a draft QR on desktop", () => {
    installMatchMedia(true);
    const requestCamera = vi.fn();
    function CameraProbe() {
      useEffect(requestCamera, []);
      return <p>Camera mounted</p>;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MobileOnlyGate draftHandoff>
          <CameraProbe />
        </MobileOnlyGate>,
      );
    });

    expect(requestCamera).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Camera mounted");
    expect(container.textContent).toContain("Continue on your original phone");
    expect(container.querySelector("canvas")).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("preserves a safe QR handoff for the create route", () => {
    installMatchMedia(true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MobileOnlyGate>
          <p>Camera landing</p>
        </MobileOnlyGate>,
      );
    });

    expect(container.textContent).toBe("");
    expect(container.querySelector("canvas")).not.toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("mounts mobile content on a mobile viewport", () => {
    installMatchMedia(false);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MobileOnlyGate>
          <p>Mobile editor</p>
        </MobileOnlyGate>,
      );
    });

    expect(container.textContent).toContain("Mobile editor");
    act(() => {
      root.unmount();
    });
  });

  it("responds to media changes without retaining mobile side effects", () => {
    const media = installMatchMedia(false);
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function MobileProbe() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <p>Mobile editor</p>;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MobileOnlyGate>
          <MobileProbe />
        </MobileOnlyGate>,
      );
    });
    act(() => {
      media.setMatches(true);
    });

    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("");
    expect(container.textContent).not.toContain("Mobile editor");
    act(() => {
      root.unmount();
    });
  });

  it("preserves native form controls and consent during mobile hydration", async () => {
    const landing = (
      <MobileOnlyGate renderMobileFallback>
        <form>
          <input type="checkbox" required />
          <input type="file" />
        </form>
      </MobileOnlyGate>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(landing);
    document.body.append(container);
    const declaration = container.querySelector("input");
    const upload = container.querySelector('input[type="file"]');
    if (!declaration || !upload) throw new Error("Expected upload form.");
    declaration.checked = true;
    installMatchMedia(false);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, landing);
      await Promise.resolve();
    });
    try {
      expect(container.querySelector("input")?.checked).toBe(true);
      expect(container.querySelector("input")).toBe(declaration);
      expect(container.querySelector('input[type="file"]')).toBe(upload);
    } finally {
      act(() => { root?.unmount(); });
    }
  });

  it("hydrates the server fallback into the computed desktop state", async () => {
    const serverHtml = renderToString(
      <MobileOnlyGate renderMobileFallback>
        <p>Useful no-JS landing</p>
      </MobileOnlyGate>,
    );
    expect(serverHtml).toContain("Useful no-JS landing");
    installMatchMedia(true);
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(
        container,
        <MobileOnlyGate renderMobileFallback>
          <p>Useful no-JS landing</p>
        </MobileOnlyGate>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Useful no-JS landing");
    expect(container.textContent).toBe("");
    act(() => {
      root?.unmount();
    });
  });

  it("never mounts deferred mobile work while hydrating a desktop route", async () => {
    const mounted = vi.fn();
    function SideEffectProbe() {
      useEffect(() => {
        mounted();
      }, []);
      return <p>Deferred mobile work</p>;
    }
    const serverHtml = renderToString(
      <MobileOnlyGate draftHandoff>
        <SideEffectProbe />
      </MobileOnlyGate>,
    );
    expect(serverHtml).not.toContain("Deferred mobile work");
    installMatchMedia(true);
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(
        container,
        <MobileOnlyGate draftHandoff>
          <SideEffectProbe />
        </MobileOnlyGate>,
      );
      await Promise.resolve();
    });

    expect(mounted).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Continue on your original phone");
    act(() => {
      root?.unmount();
    });
  });
});
