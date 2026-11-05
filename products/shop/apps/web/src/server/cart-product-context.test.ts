import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { getCartProductContext } from "./cart-product-context";
import { resolveVerifiedProductLine } from "./cart-program";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", () => ({ fetch: mocks.fetch }));
vi.mock("@/env", () => ({ env: { FOREVER_TEE_API_URL: "https://api.example.com", FOREVER_TEE_API_SHARED_SECRET: "fixture-secret" } }));
const productId = "00000000-0000-4000-8000-000000000001";
const designId = "00000000-0000-4000-8000-000000000002";
const context = { productId, designId, baseShopifyHandle: "base-shirt" };
beforeEach(() => { mocks.fetch.mockReset().mockImplementation(() => Promise.resolve(Response.json(context))); });
const read = () => Effect.runPromise(Effect.either(getCartProductContext(productId)));

it("uses one authenticated, non-redirecting request and server-owned line attributes", async () => {
  const result = await Effect.runPromise(resolveVerifiedProductLine(productId));
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.fetch).toHaveBeenCalledWith(new URL(`https://api.example.com/v2/internal/cart-product-context/${productId}`),
    expect.objectContaining({ headers: { "x-forever-tee-service-secret": "fixture-secret" }, redirect: "error" }));
  expect(result).toMatchObject({ baseShopifyHandle: "base-shirt", designId });
  expect(result.attributes).toEqual(expect.arrayContaining([
    { key: "_productId", value: productId }, { key: "_designId", value: designId },
    { key: "_artworkUrl", value: `https://api.example.com/v1/designs/${designId}/artwork` },
  ]));
});

it.each([
  { ...context, productId: designId }, { ...context, designId: "bad" },
  { ...context, baseShopifyHandle: "" }, { productId }, null,
])("fails closed on invalid or mismatched identity %#", async payload => {
  mocks.fetch.mockResolvedValue(Response.json(payload));
  expect(await read()).toMatchObject({ _tag: "Left", left: { _tag: "DependencyUnavailable" } });
});

it("preserves a verified business rejection", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ error: { code: "CartRejected", message: "This design is unavailable." } }, { status: 409 }));
  expect(await read()).toMatchObject({ _tag: "Left", left: { _tag: "CartRejected", message: "This design is unavailable." } });
});

it("preserves the design dependency error without treating it as a business rejection", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ error: { code: "DependencyUnavailable", message: "Design storage is unavailable." } }, { status: 503 }));
  expect(await read()).toMatchObject({ _tag: "Left", left: { _tag: "DependencyUnavailable", message: "Design storage is unavailable." } });
});

it.each([
  { status: 409, code: "DependencyUnavailable", message: "wrong status" },
  { status: 503, code: "CartRejected", message: "wrong status" },
  { status: 409, code: "CartRejected", message: "" },
  { status: 409, code: "Unknown", message: "unknown rejection" },
])("rejects mismatched or malformed error responses %#", async ({ status, code, message }) => {
  mocks.fetch.mockResolvedValue(Response.json({ error: { code, message } }, { status }));
  expect(await read()).toMatchObject({ _tag: "Left", left: {
    _tag: "DependencyUnavailable", message: "Product storage is unavailable.",
  } });
});

it.each([401, 404, 500, 503])("does not retry or accept HTTP %i", async status => {
  mocks.fetch.mockResolvedValue(new Response("unavailable", { status }));
  expect(await read()).toMatchObject({ _tag: "Left", left: { _tag: "DependencyUnavailable" } });
  expect(mocks.fetch).toHaveBeenCalledOnce();
});

it("fails closed on transport failure", async () => {
  mocks.fetch.mockRejectedValue(new Error("offline"));
  expect(await read()).toMatchObject({ _tag: "Left", left: { _tag: "DependencyUnavailable" } });
});

it("does not cache context between requests", async () => {
  expect(await read()).toMatchObject({ _tag: "Right" });
  mocks.fetch.mockResolvedValue(Response.json({ error: { code: "CartRejected", message: "This product is unavailable." } }, { status: 409 }));
  expect(await read()).toMatchObject({ _tag: "Left" });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
