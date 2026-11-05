// @vitest-environment happy-dom

import type { ShopifyGlobal } from "@shopify/hydrogen";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

type Configuration = Parameters<ShopifyGlobal["actions"]["updateCart"]["configure"]>[0];
let destroy: (() => void) | undefined;
let configuredHandler: Configuration["handler"];

afterEach(() => vi.unstubAllGlobals());
afterAll(() => destroy?.());

async function transport() {
  if (configuredHandler) return configuredHandler;
  let handler: Configuration["handler"];
  const configure = vi.fn((config: Configuration) => {
    handler = config.handler;
    return true;
  });
  vi.stubGlobal("Shopify", { actions: { updateCart: { configure } } });
  const { configureCartEndpoint, createCartStore } = await import("@shopify/hydrogen");
  configureCartEndpoint("/api/cart");
  const store = createCartStore({ initialData: { cart: null } });
  destroy = () => { store.destroy(); };
  store.connect();
  await vi.waitFor(() => { expect(configure).toHaveBeenCalled(); });
  if (!handler) throw new Error("Expected Hydrogen's cart transport");
  configuredHandler = handler;
  return handler;
}

const defaultHandler = () => Promise.reject(new Error("Unexpected default transport"));

describe("Hydrogen cart mutation ordering", () => {
  it("continues after a failed request and skips a superseded queued request", async () => {
    const gate = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(Response.json({ cart: { id: "same-cart" } }));
    vi.stubGlobal("fetch", fetcher);
    const update = await transport();
    const first = update(defaultHandler, { note: "first" });
    const firstResult = expect(first).rejects.toThrow();
    const controller = new AbortController();
    const skipped = update(defaultHandler, { note: "superseded" }, { signal: controller.signal });
    const skippedResult = expect(skipped).rejects.toThrow();
    controller.abort();
    const latest = update(defaultHandler, { note: "latest" });
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    gate.resolve(new Response(null, { status: 503 }));
    await Promise.all([firstResult, skippedResult]);
    await expect(latest).resolves.toMatchObject({ cart: { id: "same-cart" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ note: "latest" }));
  });

  it("settles the first cart creation before sending another addition", async () => {
    const gate = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(Response.json({ cart: { id: "same-cart", totalQuantity: 2 } }));
    vi.stubGlobal("fetch", fetcher);
    const update = await transport();
    const first = update(defaultHandler, { lines: [{ merchandiseId: "shirt", quantity: 1 }] });
    const second = update(defaultHandler, { lines: [{ merchandiseId: "tote", quantity: 1 }] });
    await new Promise(resolve => setTimeout(resolve, 10));
    try {
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve(Response.json({ cart: { id: "same-cart", totalQuantity: 1 } }));
    }
    await first;
    await expect(second).resolves.toMatchObject({ cart: { id: "same-cart", totalQuantity: 2 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps an already-sent mutation ordered when its UI operation is superseded", async () => {
    const gate = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(Response.json({ cart: { id: "same-cart" } }));
    vi.stubGlobal("fetch", fetcher);
    const update = await transport();
    const controller = new AbortController();
    const first = update(defaultHandler, { note: "first" }, { signal: controller.signal });
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    controller.abort();
    const second = update(defaultHandler, { note: "latest" });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    gate.resolve(Response.json({ cart: { id: "same-cart" } }));
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
