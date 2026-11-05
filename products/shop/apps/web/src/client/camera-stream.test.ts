// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { hasMultipleCameras, requestCameraStream } from "./camera-stream";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("times out a stalled request and stops a camera granted after the timeout", async () => {
  vi.useFakeTimers();
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  const grant = Promise.withResolvers<typeof stream>();
  const getUserMedia = vi.fn(() => grant.promise);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const request = requestCameraStream({ facingMode: { exact: "environment" } });
  const failure = expect(request).rejects.toThrow("took too long");
  await vi.advanceTimersByTimeAsync(10_000);
  await failure;
  grant.resolve(stream);
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: { exact: "environment" } } });
});

it("clears the deadline without stopping a successfully acquired camera", async () => {
  vi.useFakeTimers();
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  expect(await requestCameraStream({ facingMode: "user" })).toBe(stream);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(stop).not.toHaveBeenCalled();
});

it.each([
  [[], false],
  [[{ kind: "videoinput", deviceId: "" }], false],
  [[{ kind: "videoinput", deviceId: "front" }, { kind: "audioinput", deviceId: "microphone" }], false],
  [[{ kind: "videoinput", deviceId: "front" }, { kind: "videoinput", deviceId: "front" }], false],
  [[{ kind: "videoinput", deviceId: "front" }, { kind: "videoinput", deviceId: "rear" }], true],
])("detects distinct, disclosed cameras from %j", async (devices, expected) => {
  vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: vi.fn().mockResolvedValue(devices) } });
  expect(await hasMultipleCameras()).toBe(expected);
});

it("keeps capture available when device discovery fails", async () => {
  vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: vi.fn().mockRejectedValue(new Error("Unavailable")) } });
  expect(await hasMultipleCameras()).toBe(false);
});
