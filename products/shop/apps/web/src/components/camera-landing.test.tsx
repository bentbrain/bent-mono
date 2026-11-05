// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraLanding } from "@/components/camera-landing";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
}));

vi.mock("@/components/camera-permission-launcher", () => ({ CameraPermissionLauncher: () => <div>Preparing image</div> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("CameraLanding", () => {
  it("opens the camera with client navigation while preserving the form fallback", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetchRequest = vi.fn(() => Promise.resolve(new Response(null, {
      status: 204,
    })));
    vi.stubGlobal("fetch", fetchRequest);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<CameraLanding />);
    });

    expect(container.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
    ).toEqual([
      "Open the camera or upload an image",
      "Wear a blank t-shirt in your photo",
      "Try to get just your head and torso in the shot",
    ]);
    const form = container.querySelector("form");
    if (!form) throw new Error("Expected the camera form.");
    expect(form.getAttribute("action")).toBe("/api/content-declaration");
    expect(form.getAttribute("method")).toBe("post");
    const declaration = container.querySelector<HTMLInputElement>(
      'input[name="contentDeclaration"]',
    );
    if (!declaration) throw new Error("Expected the content declaration.");
    expect(declaration.required).toBe(true);
    expect(declaration.value).toBe("accepted");
    expect(container.textContent).toContain("I'm 18 or older");
    expect(container.querySelector('a[href="/content-rules"]')).not.toBeNull();

    declaration.click();
    await act(async () => {
      form.dispatchEvent(new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(fetchRequest).toHaveBeenCalledWith(
      "/api/content-declaration",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.routerPush).toHaveBeenCalledWith("/create/camera");

    act(() => { root.unmount(); });
  });

  it("restores a fresh declaration form after starting camera navigation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, {
      status: 204,
    }))));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<CameraLanding />);
    });

    const form = container.querySelector("form");
    const declaration = container.querySelector<HTMLInputElement>(
      'input[name="contentDeclaration"]',
    );
    if (!form || !declaration) throw new Error("Expected the camera declaration form.");

    declaration.click();
    await act(async () => {
      form.dispatchEvent(new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(declaration.checked).toBe(true);
    expect(container.querySelector("button")?.textContent).toBe("Opening…");
    expect(container.querySelector("button")?.hasAttribute("disabled")).toBe(true);

    act(() => { vi.runOnlyPendingTimers(); });

    expect(declaration.checked).toBe(false);
    expect(container.querySelector("button")?.textContent).toBe("Open camera");
    expect(container.querySelector("button")?.hasAttribute("disabled")).toBe(false);

    act(() => { root.unmount(); });
  });
});
