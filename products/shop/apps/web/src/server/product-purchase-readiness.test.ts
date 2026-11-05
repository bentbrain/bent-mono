import { afterEach, describe, expect, it, vi } from "vitest";
import { productPurchaseReadiness } from "./product-purchase-readiness";

vi.mock("@/env", () => ({ env: {
  FOREVER_TEE_API_SHARED_SECRET: "private-service-secret",
  FOREVER_TEE_API_URL: "https://api.example.com",
} }));

const url = "https://shop.example/api/product-purchase-readiness/663a5ae0-8583-4b95-a329-33f42dd9750c";
afterEach(() => vi.unstubAllGlobals());

describe("product purchase readiness", () => {
  it.each([
    "https://attacker.invalid/api/product-purchase-readiness/%2f%2fattacker.invalid",
    "https://attacker.invalid/api/product-purchase-readiness/663a5ae0-8583-4b95-a329-33f42dd9750c%5cattacker.invalid",
  ])("rejects hostile product paths without a request: %s", async input => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect((await productPurchaseReadiness(new Request(input))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("pins the upstream origin and rejects redirects independently of the incoming origin", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "https://attacker.invalid/collect" },
    }));
    vi.stubGlobal("fetch", upstream);
    const response = await productPurchaseReadiness(new Request(url.replace("shop.example", "attacker.invalid") + "?url=https://attacker.invalid"));
    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBe(false);
    expect(upstream).toHaveBeenCalledWith(
      new URL("https://api.example.com/v2/internal/configured-products/663a5ae0-8583-4b95-a329-33f42dd9750c/purchase-readiness"),
      expect.objectContaining({ redirect: "error" }));
  });

  it.each([false, true])("returns only public readiness and briefly shares pending preparation: %s", async ready => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ready, secret: "must-not-forward" }));
    vi.stubGlobal("fetch", upstream);
    const response = await productPurchaseReadiness(new Request(url));
    expect(await response.json()).toEqual({ ready });
    expect(response.headers.get("Cache-Control")).toBe(ready ? "public, max-age=0, s-maxage=300" : "public, max-age=0, s-maxage=1");
    expect(upstream).toHaveBeenCalledWith(new URL("https://api.example.com/v2/internal/configured-products/663a5ae0-8583-4b95-a329-33f42dd9750c/purchase-readiness"), expect.objectContaining({ cache: "no-store" }));
  });

  it("forwards the public retry identity while excluding private job fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ready: false,
      retryArtwork: { designId: "design", artworkJobId: "job", sourceKey: "private-source" } })));
    const response = await productPurchaseReadiness(new Request(url));
    expect(await response.json()).toEqual({ ready: false, retryArtwork: { designId: "design", artworkJobId: "job" } });
  });

  it.each([Response.json({ ready: "true" }), new Response(null, { status: 503 }), new Response(null, { status: 404 })])("fails closed without caching an invalid or failed readiness response", async upstreamResponse => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstreamResponse));
    const response = await productPurchaseReadiness(new Request(url));
    expect(response.ok).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
