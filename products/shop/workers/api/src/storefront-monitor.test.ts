import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStorefrontAvailability } from "./storefront-monitor";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("production storefront availability", () => {
  it("never probes production from fixtures or development", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await checkStorefrontAvailability(); await checkStorefrontAvailability("development");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses bounded read-only probes and records failed status without blocking maintenance", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await checkStorefrontAvailability("production");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["HEAD", "HEAD"]);
    expect(fetcher.mock.calls.map(call => call[1]?.body)).toEqual([undefined, undefined]);
    expect(log).toHaveBeenCalledWith("bent.shop storefront unavailable", expect.objectContaining({ route: "/create", status: 503 }));
  });
  it("records network failures safely without preventing the other probe", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("private-token customer@example.com")).mockResolvedValueOnce(new Response(null, { status: 200 })));
    await checkStorefrontAvailability("production");
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-token|customer@example/);
  });
});
