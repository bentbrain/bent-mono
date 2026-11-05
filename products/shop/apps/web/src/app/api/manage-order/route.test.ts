import {beforeEach, describe, expect, it, vi} from "vitest";
const {upstream} = vi.hoisted(() => ({upstream: vi.fn<typeof fetch>()}));
vi.mock("undici", () => ({fetch: upstream}));
vi.mock("@/env", () => ({env: {FOREVER_TEE_API_URL: "https://api.example.com", FOREVER_TEE_API_SHARED_SECRET: "test-service"}}));
import {GET, POST} from "./route";
const token = "a".repeat(43);
beforeEach(() => {upstream.mockReset();});
describe("private order BFF", () => {
  it("uses headers and no-store for an authenticated read", async () => {
    upstream.mockResolvedValue(Response.json({orderName: "#fixture"}));
    const result = await GET(new Request("https://shop.example.com/api/manage-order", {headers: {authorization: `Bearer ${token}`}}));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    const [url, options] = upstream.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("https://api.example.com/v2/internal/manage-order"));
    expect(options?.method).toBe("GET");
    expect(options?.body).toBeUndefined();
    expect(options?.headers).toMatchObject({"x-order-management-capability": token, "x-forever-tee-service-secret": "test-service"});
  });
  it("rejects cross-origin mutations and requests without the private capability", async () => {
    expect((await GET(new Request("https://shop.example.com/api/manage-order"))).status).toBe(410);
    expect((await POST(new Request("https://shop.example.com/api/manage-order", {method: "POST", headers: {authorization: `Bearer ${token}`, origin: "https://other.example.com", "content-type": "application/json"}, body: "{}"}))).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("accepts the actual host when Next normalizes its internal URL", async () => {
    upstream.mockResolvedValue(Response.json({status: "succeeded"}));
    const response = await POST(new Request("http://localhost:4317/api/manage-order", {method: "POST", headers: {authorization: `Bearer ${token}`, host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317", "content-type": "application/json"}, body: "{}"}));
    expect(response.status).toBe(200);
  });
  it("forwards only explicit same-origin mutations", async () => {
    upstream.mockResolvedValue(Response.json({status: "processing"}, {status: 202}));
    const response = await POST(new Request("https://shop.example.com/api/manage-order", {method: "POST", headers: {authorization: `Bearer ${token}`, origin: "https://shop.example.com", "content-type": "application/json"}, body: '{"operation":"cancel"}'}));
    expect(response.status).toBe(202);
    expect(upstream.mock.calls[0]?.[1]?.body).toBe('{"operation":"cancel"}');
  });
});
