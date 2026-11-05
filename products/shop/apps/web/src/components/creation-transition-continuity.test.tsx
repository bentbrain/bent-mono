// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraMobileRoute } from "@/components/camera-mobile-route";
import { DesignEditorMobileContent } from "@/components/design-editor-mobile-content";
import { ShirtEditor } from "@/components/shirt-editor";
import { DEFAULT_SETTINGS } from "@/lib/recursive-image";

vi.mock("@/client/design-api", () => ({
  createDesign: vi.fn(),
  getArtworkPreview: vi.fn(),
  getDesign: () => new Promise(() => undefined),
  processDesignArtwork: vi.fn(),
  updateDesignSettings: vi.fn(),
}));

vi.mock("@/client/product-availability", () => ({
  getBaseProductAvailability: () => new Promise(() => undefined),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/design/design-id",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("camera=1"),
}));

vi.mock("@/components/turnstile-challenge", () => ({
  TurnstileChallenge: () => <div data-testid="security-check" />,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("creation transition continuity", () => {
  it("server-renders the camera preparation state for mobile navigation", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CameraMobileRoute />);

    expect(
      container.querySelector('[role="status"][aria-label="Preparing camera"]'),
    ).not.toBeNull();
  });

  it("uses the same preparation state while the new draft loads", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DesignEditorMobileContent cameraLaunch id="design-id" />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[role="status"][aria-label="Preparing camera"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Loading design");

    act(() => { root.unmount(); });
  });

  it("keeps preparing the camera until a video frame is ready", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const track = {
      getSettings: () => ({ facingMode: "user", deviceId: "front" }),
      applyConstraints: vi.fn(() => Promise.resolve()),
      getCapabilities: vi.fn(() => ({
        height: { max: 4_096 },
        width: { max: 4_096 },
      })),
      stop: vi.fn(),
    };
    const cameraRequest = Promise.withResolvers<{
      getTracks: () => (typeof track)[];
      getVideoTracks: () => (typeof track)[];
    }>();
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        getUserMedia: () => cameraRequest.promise,
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      value: null,
      writable: true,
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ShirtEditor
            initialDesign={{
              artworkRevision: null,
              id: "design-id",
              settings: DEFAULT_SETTINGS,
              status: "creating",
              updatedAt: "2026-09-01T00:00:00.000Z",
            }}
          />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[role="status"][aria-label="Preparing camera"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Take photo in 3 seconds"]'),
    ).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      cameraRequest.resolve({
        getTracks: () => [track],
        getVideoTracks: () => [track],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const video = container.querySelector("video");
    if (!video) throw new Error("Expected the camera video to be mounted.");
    expect(video.classList.contains("invisible")).toBe(true);
    expect(
      container.querySelector('[role="status"][aria-label="Preparing camera"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Take photo in 3 seconds"]'),
    ).toBeNull();

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
    });

    expect(video.classList.contains("visible")).toBe(true);
    expect(
      container.querySelector('[aria-label="Take photo in 3 seconds"]'),
    ).not.toBeNull();
    act(() => { root.unmount(); });
  });
});
