import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { recordCreationTrace } from "@/server/creation-trace";

const ORIGIN = "https://shop.example.com";
const validEvent = {
  attemptId: "9aefced7-c6f9-4cc2-8144-32ac13b41e04",
  code: "REQUEST_TIMEOUT",
  designId: "6f8df4a7-4672-475f-a412-e3b02383772f",
  durationMs: 30_001,
  grantDurationMs: 250,
  uploadResponseDurationMs: 8_000,
  responseDownloadDurationMs: 5_000,
  uploadBodyDurationMs: 1_000,
  portraitDurationMs: 3_000,
  previewBytes: 80_000,
  networkSetupDurationMs: 800,
  networkRequestDurationMs: 7_200,
  workerDurationMs: 2_100,
  screeningDurationMs: 820,
  previewDurationMs: 140,
  uploadBytes: 200_000,
  requestId: "270c8f1f-306f-45bc-8f02-b00550b7c0c5",
  retryAfterSeconds: 86_400,
  stage: "artwork_upload_failed",
  status: 0,
};

describe("creation journey tracing", () => {
  it("logs one bounded same-origin journey event", async () => {
    const info = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await recordCreationTrace(request(validEvent));

    expect(response.status).toBe(204);
    expect(info).toHaveBeenCalledWith(
      "[bent.shop creation] journey stage",
      validEvent,
    );
  });

  it("retains supported large uploads and timeout failures", async () => {
    expect((await recordCreationTrace(request({ ...validEvent,
      durationMs: 180_001, networkRequestDurationMs: 180_000,
      uploadBytes: 20_000_000,
    }))).status).toBe(204);
  });

  it.each([
    { ...validEvent, designId: "not-a-design" },
    { ...validEvent, message: "unbounded text" },
    { ...validEvent, requestId: "bad request id" },
    { ...validEvent, stage: "arbitrary_event" },
    { ...validEvent, workerDurationMs: -1 },
    { ...validEvent, grantDurationMs: -1 },
    { ...validEvent, uploadResponseDurationMs: 600_001 },
    { ...validEvent, responseDownloadDurationMs: "secret" },
    { ...validEvent, uploadBodyDurationMs: 0.5 },
    { ...validEvent, portraitDurationMs: -1 },
    { ...validEvent, previewBytes: 1_024 * 1_024 + 1 },
    { ...validEvent, networkSetupDurationMs: "secret" },
    { ...validEvent, networkRequestDurationMs: 600_001 },
    { ...validEvent, previewDurationMs: 600_001 },
    { ...validEvent, screeningDurationMs: "secret" },
    { ...validEvent, uploadBytes: 20_000_001 },
  ])("rejects malformed or unbounded event fields", async (event) => {
    expect((await recordCreationTrace(request(event))).status).toBe(400);
  });

  it("rejects cross-origin and oversized reports", async () => {
    expect((await recordCreationTrace(request(validEvent, "https://other.example.com"))).status)
      .toBe(403);
    const oversized = { ...validEvent, code: "A".repeat(2_100) };
    expect((await recordCreationTrace(request(oversized))).status).toBe(400);
  });
});

function request(event: unknown, origin = ORIGIN) {
  const body = JSON.stringify(event);
  return new Request(`${ORIGIN}/api/creation-trace`, {
    body,
    headers: {
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "content-type": "application/json",
      origin,
    },
    method: "POST",
  });
}
