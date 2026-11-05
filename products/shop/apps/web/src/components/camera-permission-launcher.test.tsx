// @vitest-environment happy-dom

import { act, Activity } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraPermissionLauncher } from "@/components/camera-permission-launcher";
import { discardCameraHandoff } from "@/client/camera-handoff";
import { takeImageForDraft } from "@/client/image-handoff";

const createDesign = vi.fn<(token: string, signal?: AbortSignal) => Promise<{
  diagnostics: { durationMs: number; requestId: string | undefined };
  id: string;
}>>();
const onDraftCreated = vi.fn<(designId: string) => void>();
const reportCreationTrace = vi.fn<(event: unknown) => void>();

vi.mock("@/client/design-api", () => ({
  createDesign: (token: string, signal?: AbortSignal) => createDesign(token, signal),
}));
vi.mock("@/client/creation-trace", () => ({
  reportCreationTrace: (event: unknown) => {
    reportCreationTrace(event);
  },
}));
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" },
}));

afterEach(() => {
  discardCameraHandoff();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete window.bentTurnstileReady;
  delete window.turnstile;
  document.getElementById("turnstile-script")?.remove();
  document.body.replaceChildren();
});

describe("CameraPermissionLauncher", () => {
  it("waits for the security challenge and hands off uploads without accessing the camera", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    const challenges: Parameters<NonNullable<Window["turnstile"]>["render"]>[1][] = [];
    window.turnstile = {
      remove: vi.fn(), reset: vi.fn(),
      render(_container, options) { challenges.push(options); return "widget"; },
    };
    createDesign.mockResolvedValue({ id: "upload-design", diagnostics: { durationMs: 1, requestId: undefined } });
    const image = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    const root = createRoot(document.createElement("div"));
    act(() => { root.render(<CameraPermissionLauncher image={image} onDraftCreated={onDraftCreated} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(createDesign).not.toHaveBeenCalled();
    const challenge = challenges[0];
    if (!challenge) throw new Error("Expected the upload security challenge.");
    await act(async () => { challenge.callback("upload-token"); await Promise.resolve(); });
    expect(createDesign).toHaveBeenCalledWith("upload-token", expect.any(AbortSignal));
    expect(onDraftCreated).toHaveBeenCalledWith("upload-design");
    expect(takeImageForDraft("unrelated-design")).toBeUndefined();
    expect(takeImageForDraft("upload-design")).toBe(image);
    expect(takeImageForDraft("upload-design")).toBeUndefined();
    expect(getUserMedia).not.toHaveBeenCalled();
    act(() => { root.unmount(); });
  });

  it("releases an unused camera while a security challenge remains pending", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop }] }),
    } });
    window.turnstile = { remove: vi.fn(), reset: vi.fn(), render: vi.fn(() => "widget") };
    const root = createRoot(document.createElement("div"));
    act(() => { root.render(<CameraPermissionLauncher onDraftCreated={onDraftCreated} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(stop).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(stop).toHaveBeenCalledOnce();
    expect(createDesign).not.toHaveBeenCalled();
    act(() => { root.unmount(); });
  });

  it("requires fresh camera and challenge state when a cached route is restored", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    createDesign.mockResolvedValue({
      diagnostics: { durationMs: 120, requestId: "request-id" },
      id: "design-id",
    });
    const challengeOptions: Parameters<NonNullable<Window["turnstile"]>["render"]>[1][] = [];
    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render(_container, options) {
        challengeOptions.push(options);
        return `widget-${String(challengeOptions.length)}`;
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const renderActivity = (mode: "hidden" | "visible") => {
      root.render(
        <Activity mode={mode}>
          <CameraPermissionLauncher onDraftCreated={onDraftCreated} />
        </Activity>,
      );
    };

    act(() => { renderActivity("visible"); });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstChallenge = challengeOptions[0];
    if (!firstChallenge) throw new Error("Expected the first security challenge.");
    await act(async () => {
      firstChallenge.callback("first-token");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createDesign).toHaveBeenCalledOnce();

    act(() => { renderActivity("hidden"); });
    act(() => { renderActivity("visible"); });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createDesign).toHaveBeenCalledOnce();
    const restoredChallenge = challengeOptions[1];
    if (!restoredChallenge) throw new Error("Expected a restored security challenge.");
    await act(async () => {
      restoredChallenge.callback("restored-token");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createDesign).toHaveBeenCalledTimes(2);
    expect(createDesign.mock.calls[1]?.[0]).toBe("restored-token");
    expect(onDraftCreated).toHaveBeenCalledTimes(2);
    act(() => { root.unmount(); });
  });

  it("finishes draft handoff when its callback changes and the submitted token expires", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    const draft = Promise.withResolvers<{
      diagnostics: { durationMs: number; requestId: string | undefined };
      id: string;
    }>();
    createDesign.mockReturnValue(draft.promise);
    let challengeOptions: Parameters<NonNullable<Window["turnstile"]>["render"]>[1] | undefined;
    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render(_container, options) {
        challengeOptions = options;
        return "widget-1";
      },
    };
    const firstNavigation = vi.fn<(designId: string) => void>();
    const latestNavigation = vi.fn<(designId: string) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<CameraPermissionLauncher onDraftCreated={firstNavigation} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    if (!challengeOptions) throw new Error("Expected the security challenge options.");
    await act(async () => {
      challengeOptions?.callback("token");
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      root.render(<CameraPermissionLauncher onDraftCreated={latestNavigation} />);
    });
    await act(async () => {
      challengeOptions?.["expired-callback"]();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      draft.resolve({
        diagnostics: { durationMs: 120, requestId: "request-id" },
        id: "design-id",
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createDesign).toHaveBeenCalledOnce();
    expect(firstNavigation).not.toHaveBeenCalled();
    expect(latestNavigation).toHaveBeenCalledWith("design-id");
    act(() => { root.unmount(); });
  });

  it("reports draft rate limiting without blaming the security check", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    createDesign.mockRejectedValue(Object.assign(
      new Error("Too many requests."),
      { retryAfterSeconds: 82_800, status: 429 },
    ));
    let challengeOptions: Parameters<NonNullable<Window["turnstile"]>["render"]>[1] | undefined;
    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render(_container, options) {
        challengeOptions = options;
        return "widget-1";
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(<CameraPermissionLauncher onDraftCreated={onDraftCreated} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    if (!challengeOptions) throw new Error("Expected the security challenge options.");
    const options = challengeOptions;
    await act(async () => {
      options.callback("token");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "photo limit",
    );
    expect(container.textContent).not.toContain("security check could not be completed");
    act(() => { root.unmount(); });
  });

  it("reports a security failure separately from camera permission", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    createDesign.mockRejectedValue(new Error("Challenge rejected"));
    let challengeOptions: Parameters<NonNullable<Window["turnstile"]>["render"]>[1] | undefined;
    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render(_container, options) {
        challengeOptions = options;
        return "widget-1";
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(<CameraPermissionLauncher onDraftCreated={onDraftCreated} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    if (!challengeOptions) throw new Error("Expected the security challenge options.");
    const options = challengeOptions;
    await act(async () => {
      options.callback("token");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "security check could not be completed",
    );
    expect(container.textContent).not.toContain("Camera access is needed");
    act(() => { root.unmount(); });
  });

  it("leaves camera preparation when the Turnstile API becomes ready after launcher mount", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    createDesign.mockResolvedValue({
      diagnostics: { durationMs: 120, requestId: "request-id" },
      id: "design-id",
    });
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    const render = vi.fn((_container: HTMLElement, options: Parameters<NonNullable<Window["turnstile"]>["render"]>[1]) => {
      options.callback("token");
      return "widget-1";
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<CameraPermissionLauncher onDraftCreated={onDraftCreated} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render,
    };
    const ready = window.bentTurnstileReady;
    if (!ready) throw new Error("Expected the Turnstile ready callback.");
    await act(async () => {
      ready();
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(render).toHaveBeenCalledOnce();
    expect(createDesign).toHaveBeenCalledOnce();
    expect(createDesign.mock.calls[0]?.[0]).toBe("token");
    expect(onDraftCreated).toHaveBeenCalledWith("design-id");
    expect(reportCreationTrace).toHaveBeenCalledWith(expect.objectContaining({
      designId: "design-id",
      stage: "draft_handoff_started",
    }));
    act(() => { root.unmount(); });
  });

  it("leaves camera preparation when the camera request does not settle", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => new Promise(() => undefined),
      },
    });
    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render: vi.fn(() => "widget-1"),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<CameraPermissionLauncher onDraftCreated={onDraftCreated} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Camera access is needed",
    );
    act(() => { root.unmount(); });
  });

  it("leaves camera preparation when draft creation does not settle", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    createDesign.mockImplementation(() => new Promise(() => undefined));
    let challengeOptions: Parameters<NonNullable<Window["turnstile"]>["render"]>[1] | undefined;
    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render(_container, options) {
        challengeOptions = options;
        return "widget-1";
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<CameraPermissionLauncher onDraftCreated={onDraftCreated} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    if (!challengeOptions) throw new Error("Expected the security challenge options.");
    const options = challengeOptions;
    await act(async () => {
      options.callback("token");
      await Promise.resolve();
    });
    expect(createDesign).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "security check could not be completed",
    );
    act(() => { root.unmount(); });
  });
});
