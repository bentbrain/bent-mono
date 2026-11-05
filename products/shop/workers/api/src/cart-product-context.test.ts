import {
  type DesignDto,
  type ProductDto,
} from "@forever-tee/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getProduct as getProductFromApi } from "./product-programs";
import { getDesign as getDesignFromApi } from "./design-programs";
import { resolveCartProductContext as resolveVerifiedProductLine } from "./cart-product-context";
import { ProductNotFound } from "./product-errors";
import { DesignNotFound, DatabaseFailure } from "./design-errors";
import { ProductRepository } from "./product-repository";
import { DesignRepository } from "./design-repository";

vi.mock("./product-programs", () => ({ getProduct: vi.fn() }));
vi.mock("./design-programs", () => ({ getDesign: vi.fn() }));

const base: ProductDto = {
  id: "00000000-0000-4000-8000-000000000001", baseProductId: "00000000-0000-4000-8000-000000000001", designId: null, designRevisionId: null,
  placement: null, projectionVersion: null, defaultColor: "White",
  shopifyHandle: "bent-shirt", createdAt: "2026-09-09T00:00:00Z",
};
const configured: ProductDto = { ...base, id: "00000000-0000-4000-8000-000000000002", designId: "00000000-0000-4000-8000-000000000003" };
const design: DesignDto = {
  id: "00000000-0000-4000-8000-000000000003", status: "ready", contentType: "image/png", artworkRevision: null,
  artworkUrl: "https://api.example.com/artwork",
  createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
  settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.3, placementY: 0.3, placementWidth: 0.2, depth: 5 },
};

beforeEach(() => {
  vi.mocked(getProductFromApi).mockReset().mockImplementation(id =>
    Effect.succeed(id === configured.id ? configured : base));
  vi.mocked(getDesignFromApi).mockReset().mockReturnValue(Effect.succeed(design));
});
afterEach(() => vi.useRealTimers());

const unused = () => { throw new Error("Expected the mocked repository program."); };
const resolve = () => Effect.runPromise(resolveVerifiedProductLine(configured.id).pipe(
  Effect.provideService(ProductRepository, { find: unused, createConfigured: unused, findFamily: unused,
    findActiveRevisionSnapshot: unused, findHistoricalRevisionSnapshot: unused, findRevisionArtwork: unused }),
  Effect.provideService(DesignRepository, { find: unused, create: unused, uploadArtwork: unused,
    artwork: unused, artworkPreview: unused, updateSettings: unused }),
  Effect.either,
));

it("overlaps the two independent reads without dropping any request", async () => {
  vi.useFakeTimers();
  const reads: { id: string; at: number }[] = [];
  const start = Date.now();
  vi.mocked(getProductFromApi).mockImplementation(id => Effect.gen(function*() {
    reads.push({ id, at: Date.now() - start });
    yield* Effect.sleep(100);
    return id === configured.id ? configured : base;
  }));
  vi.mocked(getDesignFromApi).mockImplementation(id => Effect.gen(function*() {
    reads.push({ id, at: Date.now() - start });
    yield* Effect.sleep(100);
    return design;
  }));
  const pending = resolve().then(result => ({ result, elapsed: Date.now() - start }));
  await vi.runAllTimersAsync();
  const { result, elapsed } = await pending;
  console.info("Cart resolver fixture", JSON.stringify({ reads, elapsed }));
  expect(result).toMatchObject({ _tag: "Right", right: {
    baseShopifyHandle: "bent-shirt", designId: design.id,
  } });
  if (result._tag !== "Right") throw new Error("Expected a verified product line.");
  expect(result.right.productId).toBe(configured.id);
  expect(reads).toEqual([
    { id: configured.id, at: 0 }, { id: base.id, at: 100 }, { id: design.id, at: 100 },
  ]);
  expect(elapsed).toBe(200);
});

it.each([
  new ProductNotFound({ id: "missing" }),
  new DatabaseFailure({ operation: "read", cause: "offline" }),
])("stops at a failed configured-product read: $._tag", async error => {
  vi.mocked(getProductFromApi).mockReturnValue(Effect.fail(error));
  expect(await resolve()).toMatchObject({ _tag: "Left", left: {
    _tag: error._tag === "ProductNotFound" ? "CartRejected" : "DependencyUnavailable",
    message: error._tag === "ProductNotFound" ? "This product is unavailable." : "Product storage is unavailable.",
  } });
  expect(getProductFromApi).toHaveBeenCalledOnce();
  expect(getDesignFromApi).not.toHaveBeenCalled();
});

it("does not launch dependent reads for an unconfigured product", async () => {
  vi.mocked(getProductFromApi).mockReturnValue(Effect.succeed(base));
  expect(await resolve()).toMatchObject({ _tag: "Left", left: {
    _tag: "CartRejected", message: "Create a design before adding this product.",
  } });
  expect(getProductFromApi).toHaveBeenCalledOnce();
  expect(getDesignFromApi).not.toHaveBeenCalled();
});

const baseFailures: {
  read: ReturnType<typeof getProductFromApi>;
  tag: string;
  message: string;
}[] = [
  { read: Effect.fail(new ProductNotFound({ id: "missing" })), tag: "CartRejected", message: "This product is unavailable." },
  { read: Effect.fail(new DatabaseFailure({ operation: "read", cause: "offline" })), tag: "DependencyUnavailable", message: "Product storage is unavailable." },
  { read: Effect.succeed({ ...base, designId: design.id }), tag: "CartRejected", message: "This product has an invalid base product." },
  { read: Effect.succeed({ ...base, id: configured.id }), tag: "CartRejected", message: "This product has an invalid base product." },
];

it.each(baseFailures)("preserves base-error precedence when the design fails first %#", async ({ read, tag, message }) => {
  vi.useFakeTimers();
  vi.mocked(getProductFromApi).mockImplementation(id => id === configured.id
    ? Effect.succeed(configured) : read.pipe(Effect.delay(100)));
  vi.mocked(getDesignFromApi).mockReturnValue(Effect.fail(new DesignNotFound({ id: "missing" })));
  const pending = resolve();
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ _tag: "Left", left: { _tag: tag, message } });
  expect(getDesignFromApi).toHaveBeenCalledOnce();
});

it("does not release a verified line while the design read is pending", async () => {
  vi.useFakeTimers();
  vi.mocked(getDesignFromApi).mockReturnValue(Effect.succeed(design).pipe(Effect.delay(200)));
  let settled = false;
  const pending = resolve().then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(100);
  expect(getDesignFromApi).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ _tag: "Right" });
});

it.each([
  { read: Effect.fail(new DesignNotFound({ id: "missing" })), tag: "CartRejected", message: "This design is unavailable." },
  { read: Effect.fail(new DatabaseFailure({ operation: "read", cause: "offline" })), tag: "DependencyUnavailable", message: "Design storage is unavailable." },
  { read: Effect.succeed<DesignDto>({ ...design, status: "creating" }), tag: "CartRejected", message: "This design is still preparing its print-ready artwork." },
])("retains design rejection: $message", async ({ read, tag, message }) => {
  vi.mocked(getDesignFromApi).mockReturnValue(read);
  expect(await resolve()).toMatchObject({ _tag: "Left", left: { _tag: tag, message } });
});

it("does not share verification results across resolver calls", async () => {
  expect(await resolve()).toMatchObject({ _tag: "Right" });
  vi.mocked(getProductFromApi).mockReturnValue(Effect.fail(new ProductNotFound({ id: "retired" })));
  expect(await resolve()).toMatchObject({ _tag: "Left", left: { message: "This product is unavailable." } });
  expect(getProductFromApi).toHaveBeenCalledTimes(3);
});
