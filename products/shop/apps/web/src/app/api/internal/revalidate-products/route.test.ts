import { beforeEach, describe, expect, it, vi } from "vitest";
const { revalidate } = vi.hoisted(() => ({ revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: revalidate }));
vi.mock("@/env", () => ({ env: { FOREVER_TEE_API_SHARED_SECRET: "service-secret" } }));
import { POST } from "./route";
beforeEach(() => vi.clearAllMocks());
describe("product lifecycle cache invalidation", () => {
  it("rejects unauthenticated invalidation", () => {
    const response = POST(new Request("https://shop.example.com/api/internal/revalidate-products", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(revalidate).not.toHaveBeenCalled();
  });
  it("expires every product-family entry immediately after an authenticated operation", () => {
    const response = POST(new Request("https://shop.example.com/api/internal/revalidate-products", { method: "POST", headers: { "x-forever-tee-service-secret": "service-secret" } }));
    expect(response.status).toBe(200);
    expect(revalidate).toHaveBeenCalledWith("product-records", { expire: 0 });
    expect(revalidate).toHaveBeenCalledWith("fulfilment-estimates", { expire: 0 });
  });
});
