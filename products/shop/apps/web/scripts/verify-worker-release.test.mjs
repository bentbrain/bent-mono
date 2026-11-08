import { describe, expect, it, vi } from "vitest";

import {
  enforceWorkerRelease,
  EXPECTED_RELEASE,
  REQUIRED_CAPABILITIES,
} from "./verify-worker-release.mjs";

describe("Worker-first release gate", () => {
  it("skips preview and development when enforcement is not configured", async () => {
    const fetcher = vi.fn(() => {
      throw new Error("The Worker must not be called.");
    });

    await expect(enforceWorkerRelease({
      enforcement: undefined,
      apiUrl: "https://api.example.com",
      sharedSecret: "test-secret",
      fetcher,
    })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes an enabled production gate only for the expected Worker", async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({
      capabilities: REQUIRED_CAPABILITIES,
      release: EXPECTED_RELEASE,
    })));

    await expect(enforceWorkerRelease({
      enforcement: "1",
      apiUrl: "https://api.example.com",
      sharedSecret: "test-secret",
      fetcher,
    })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toEqual(
      new URL("https://api.example.com/v2/internal/capabilities"),
    );
    expect(request?.[1]?.headers).toEqual({
      "x-forever-tee-service-secret": "test-secret",
    });
  });

  it("fails an enabled production gate for a stale Worker", async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({
      capabilities: REQUIRED_CAPABILITIES,
      release: "previous-release",
    })));

    await expect(enforceWorkerRelease({
      enforcement: "1",
      apiUrl: "https://api.example.com",
      sharedSecret: "test-secret",
      fetcher,
    })).rejects.toThrow(
      `Production Worker must report release ${EXPECTED_RELEASE}`,
    );
  });

  it.each(["sales-pause-v1", "owner-artwork-media-v1"])("fails an enabled production gate when %s is missing", async missing => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({
      capabilities: REQUIRED_CAPABILITIES.filter(
        (capability) => capability !== missing,
      ),
      release: EXPECTED_RELEASE,
    })));

    await expect(enforceWorkerRelease({
      enforcement: "1",
      apiUrl: "https://api.example.com",
      sharedSecret: "test-secret",
      fetcher,
    })).rejects.toThrow("every required capability");
  });

  it("fails closed when the production enforcement value is malformed", async () => {
    await expect(enforceWorkerRelease({
      enforcement: "true",
      apiUrl: "https://api.example.com",
      sharedSecret: "test-secret",
    })).rejects.toThrow("must be exactly 1");
  });
});
