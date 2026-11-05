// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { discardCameraHandoff, retainCameraForDraft, takeCameraForDraft } from "./camera-handoff";

const stop = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: () => Promise.resolve({
      getTracks: () => [{ stop }],
      getVideoTracks: () => [{ readyState: "live" }],
    }),
  } });
});
afterEach(() => {
  discardCameraHandoff();
  vi.useRealTimers();
  vi.restoreAllMocks();
  stop.mockClear();
});

it("transfers a stream once, only to its draft, without stopping it", async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  retainCameraForDraft("draft-1", stream);
  expect(takeCameraForDraft("draft-2")).toBeUndefined();
  expect(takeCameraForDraft("draft-1")).toBe(stream);
  expect(takeCameraForDraft("draft-1")).toBeUndefined();
  vi.advanceTimersByTime(15_000);
  window.dispatchEvent(new Event("pagehide"));
  expect(stop).not.toHaveBeenCalled();
});

it.each(["timeout", "pagehide", "hidden", "discard"])("stops an unclaimed camera on %s", async reason => {
  retainCameraForDraft("draft-1", await navigator.mediaDevices.getUserMedia({ video: true }));
  if (reason === "timeout") vi.advanceTimersByTime(15_000);
  if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
  if (reason === "hidden") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  }
  if (reason === "discard") discardCameraHandoff();
  expect(stop).toHaveBeenCalledOnce();
  expect(takeCameraForDraft("draft-1")).toBeUndefined();
});

it("rejects an ended stream so the editor can acquire another", async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  vi.spyOn(stream, "getVideoTracks").mockReturnValue([]);
  retainCameraForDraft("draft-1", stream);
  expect(takeCameraForDraft("draft-1")).toBeUndefined();
  expect(stop).toHaveBeenCalledOnce();
});
