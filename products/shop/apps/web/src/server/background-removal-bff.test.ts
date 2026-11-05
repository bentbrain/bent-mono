import { afterEach, describe, expect, it, vi } from "vitest";
import type * as BffCore from "./design-draft-bff-core";
import { backgroundRemovalBff } from "./background-removal-bff";

vi.mock("@/env", () => ({ env: {
  FOREVER_TEE_API_SHARED_SECRET: "private-service-secret",
  FOREVER_TEE_API_URL: "https://api.example.com",
} }));
vi.mock("@/server/anonymous-session", () => ({ anonymousOwner: () => Promise.resolve({ ownerId: "private-owner" }) }));
vi.mock("@/server/design-draft-bff-core", async importOriginal => ({
  ...await importOriginal<typeof BffCore>(),
  hasAbuseClearance: () => Promise.resolve(true),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function uploadRequest() {
  return new Request("https://shop.bent.build/api/background-removal", {
    method: "POST", body: "private-portrait",
    headers: { origin: "https://shop.bent.build", "content-type": "image/jpeg", "content-length": "16" },
  });
}

describe("background removal diagnostics", () => {
  it("correlates upstream failures and preserves the retry response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", (_url: URL, init: RequestInit) => {
      requests.push(init);
      return Promise.resolve(Response.json({ error: { code: "PROVIDER_UNAVAILABLE" } }, { status: 503, headers: { "retry-after": "60" } }));
    });
    const response = await backgroundRemovalBff(uploadRequest());
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(requests[0]?.headers).get("x-request-id")).toBe(requestId);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: { code: "PROVIDER_UNAVAILABLE" } });
    expect(log).toHaveBeenCalledWith("[bent.shop BFF] upstream request", expect.objectContaining({ requestId, status: 503, operation: "background_removal" }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|portrait|secret/);
  });

  it("records network failures without exposing their messages or changing recovery", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("private-owner portrait private-service-secret")));
    const response = await backgroundRemovalBff(uploadRequest());
    expect(response.status).toBe(502);
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(await response.json()).toEqual({ error: { code: "UPSTREAM_UNAVAILABLE", message: "The design service is unavailable." } });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|portrait|secret/);
    expect(JSON.stringify(log.mock.calls)).toContain("TypeError");
  });
});
