import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getProductFamilyFromApi, getProductFromApi } from "./product-api-client";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", () => ({ fetch: mocks.fetch }));
vi.mock("@/env", () => ({ env: { FOREVER_TEE_API_URL: "https://api.example.com" } }));

const productId = "00000000-0000-4000-8000-000000000001";

beforeEach(() => { mocks.fetch.mockReset(); });

for (const { name, read } of [
  { name: "product", read: (id: string) => Effect.asVoid(getProductFromApi(id)) },
  { name: "product family", read: (id: string) => Effect.asVoid(getProductFamilyFromApi(id)) },
]) {
  describe(name, () => {
    it.each(["not-a-product", "", "../products", "00000000-0000-4000-8000-00000000000z"])(
      "treats malformed link %j as missing without contacting storage",
      async id => {
        mocks.fetch.mockResolvedValue(new Response("Invalid product ID", { status: 400 }));
        expect(await Effect.runPromise(Effect.either(read(id)))).toMatchObject({
          _tag: "Left", left: { _tag: "ProductNotFound" },
        });
        expect(mocks.fetch).not.toHaveBeenCalled();
      },
    );

    it("preserves a missing product returned by storage", async () => {
      mocks.fetch.mockResolvedValue(new Response(null, { status: 404 }));
      expect(await Effect.runPromise(Effect.either(read(productId)))).toMatchObject({
        _tag: "Left", left: { _tag: "ProductNotFound" },
      });
      expect(mocks.fetch).toHaveBeenCalledOnce();
    });

    it.each([400, 500, 503])("preserves HTTP %i failures for valid IDs", async status => {
      mocks.fetch.mockResolvedValue(new Response(null, { status }));
      expect(await Effect.runPromise(Effect.either(read(productId)))).toMatchObject({
        _tag: "Left", left: { _tag: "DependencyUnavailable" },
      });
      expect(mocks.fetch).toHaveBeenCalledOnce();
    });
  });
}
