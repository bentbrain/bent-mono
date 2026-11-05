// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";

const sdk = vi.hoisted(() => ({
  init: vi.fn(), capture: vi.fn(), captureException: vi.fn(),
  stopSessionRecording: vi.fn(), set_config: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: sdk }));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/create");
});

function event(properties: Record<string, unknown>): CaptureResult {
  return { uuid: "test", event: "$exception", properties };
}

describe("storefront PostHog", () => {
  it("preserves replay stylesheet content and does not blanket-mask public text", async () => {
    const { posthogOptions } = await import("./posthog");
    const recording = posthogOptions.session_recording;
    expect(recording?.maskAttributeFn?.("_cssText", ".button{display:flex;color:blue}")).toBe(".button{display:flex;color:blue}");
    expect(recording?.maskTextSelector).not.toBe("*");
  });
  it("does not initialize without configuration or on an order capability URL", async () => {
    const { initializePostHog, captureClientException } = await import("./posthog");
    initializePostHog();
    initializePostHog("test-token");
    window.history.replaceState({}, "", "/manage-order?token=private-order#secret");
    initializePostHog("test-token", "https://analytics.example.com");
    captureClientException(new Error("private order"));
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("initializes once and records actions and boundary errors without interrupting recovery", async () => {
    const { initializePostHog, captureClientException, captureStorefrontAction } = await import("./posthog");
    initializePostHog("test-token", "https://analytics.example.com");
    initializePostHog("test-token", "https://analytics.example.com");
    captureStorefrontAction("camera_open_requested");
    const error = new Error("failure");
    captureClientException(error);
    captureClientException(error);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.capture).toHaveBeenCalledWith("camera_open_requested");
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    sdk.captureException.mockImplementationOnce(() => { throw new Error("offline"); });
    expect(() => { captureClientException(new Error("next failure")); }).not.toThrow();
  });

  it("bounds handled failure context and preserves recovery when capture fails", async () => {
    const { initializePostHog, captureStorefrontFailure, captureClientException } = await import("./posthog");
    initializePostHog("test-token", "https://analytics.example.com");
    captureStorefrontFailure({ operation: "artwork_upload", status: 503, code: "PROVIDER_UNAVAILABLE", requestId: "request-123" });
    expect(sdk.capture).toHaveBeenCalledWith("storefront_failure", {
      operation: "artwork_upload", status: 503, code: "PROVIDER_UNAVAILABLE", requestId: "request-123",
    });
    captureStorefrontFailure({ operation: "design_request", status: -1, code: "private customer@example.com", requestId: "token=private" });
    expect(sdk.capture).toHaveBeenLastCalledWith("storefront_failure", {
      operation: "design_request", status: undefined, code: undefined, requestId: undefined,
    });
    captureClientException(new Error("private"), { operation: "configured_product_creation", requestId: "request-123" });
    expect(sdk.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ operation: "configured_product_creation", requestId: "request-123" }));
    sdk.capture.mockImplementationOnce(() => { throw new Error("offline"); });
    expect(() => { captureStorefrontFailure({ operation: "artwork_upload" }); }).not.toThrow();
    window.history.replaceState({}, "", "/manage-order?token=private");
    sdk.capture.mockClear();
    captureStorefrontFailure({ operation: "checkout" });
    expect(sdk.capture).not.toHaveBeenCalled();
  });

  it("attaches only a bounded deployment commit to diagnostic events", async () => {
    const { beforeSend } = await import("./posthog");
    vi.stubEnv("NEXT_PUBLIC_SOURCE_COMMIT", "a".repeat(40));
    expect(beforeSend(event({}))?.properties["sourceCommit"]).toBe("a".repeat(40));
    vi.stubEnv("NEXT_PUBLIC_SOURCE_COMMIT", "private customer@example.com");
    expect(beforeSend(event({}))?.properties["sourceCommit"]).toBeUndefined();
  });

  it("removes capabilities, dynamic IDs, attribution and error messages while retaining stack locations", async () => {
    const { beforeSend } = await import("./posthog");
    const result = beforeSend({ ...event({
      $current_url: "https://shop.bent.build/design/private-id?token=secret#secret",
      $initial_current_url: "https://shop.bent.build/?email=customer@example.com",
      $referrer: "https://example.com/private-referrer?secret=1",
      utm_campaign: "customer@example.com",
      $exception_message: "customer@example.com lives at a private address",
      $exception_list: [{ type: "TypeError", value: "private address", stacktrace: { frames: [{
        filename: "https://shop.bent.build/_next/static/chunks/app.js?token=secret",
        lineno: 42, colno: 3,
      }] } }],
    }), $set: { email: "customer@example.com" } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/secret|private-id|customer@example|private address|private-referrer/);
    expect(result?.properties["$current_url"]).toBe("https://shop.bent.build/design/[id]");
    expect(serialized).toContain("/_next/static/chunks/app.js");
    expect(serialized).toContain('"lineno":42');
    expect(result?.$set).toBeUndefined();
  });

  it("stops replay before private navigation and drops subsequent events even after leaving", async () => {
    const { initializePostHog, stopCaptureForPrivatePage, beforeSend, captureClientException } = await import("./posthog");
    initializePostHog("test-token", "https://analytics.example.com");
    stopCaptureForPrivatePage("/manage-order?token=secret");
    expect(sdk.stopSessionRecording).toHaveBeenCalledOnce();
    expect(sdk.set_config).toHaveBeenCalledWith(expect.objectContaining({ disable_session_recording: true }));
    expect(beforeSend(event({}))).toBeNull();
    expect(beforeSend({ ...event({}), event: "$snapshot" })).toBeNull();
    captureClientException(new Error("private"));
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("masks replay content and URLs before the recorder serializes them", async () => {
    const { posthogOptions } = await import("./posthog");
    const recording = posthogOptions.session_recording;
    expect(recording?.maskAllInputs).toBe(true);
    expect(recording?.maskTextSelector).toContain('[role="alert"]');
    expect(recording?.maskTextSelector).toContain(".ph-mask");
    for (const tag of ['img', 'video', 'canvas', 'input[type="file"]', 'input[type="hidden"]']) {
      expect(recording?.blockSelector).toContain(tag);
    }
    expect(recording?.maskAttributeFn?.("href", "/manage-order?token=secret")).toBe("");
    expect(recording?.maskAttributeFn?.("style", "background-image:url(blob:portrait)")).toBe("");
    expect(recording?.maskAttributeFn?.("class", "flex")).toBe("flex");
    expect(recording?.maskAttributeFn?.("href", "/_next/static/css/app.css?token=secret"))
      .toBe(`${window.location.origin}/_next/static/css/app.css`);
    expect(recording?.maskAttributeFn?.("href", "https://other.example/_next/static/private.css")).toBe("");
    expect(recording?.maskAttributeFn?.("data-state", "checked")).toBe("checked");
    expect(recording?.maskAttributeFn?.("data-customer", "private")).toBe("");
    expect(recording?.maskAttributeFn?.("value", "private")).toBe("");
    expect(recording?.maskCapturedNetworkRequestFn?.({ name: "https://shop.bent.build/?token=secret", duration: 0, startTime: 0, entryType: "navigation" })?.name)
      .toBe("https://shop.bent.build/");
    expect(posthogOptions.capture_exceptions).toEqual({ capture_unhandled_errors: true, capture_unhandled_rejections: true, capture_console_errors: false });
    expect(posthogOptions.enable_recording_console_log).toBe(false);
    expect(posthogOptions.capture_performance).toBe(false);
  });
});
