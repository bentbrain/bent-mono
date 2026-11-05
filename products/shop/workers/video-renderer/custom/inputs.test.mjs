import assert from "node:assert/strict";
import test from "node:test";
import { featuredSelection, loadFeaturedRenderInputs, selectFinalProduct, sha256 } from "./inputs.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const featured = [1, 2, 3].map(slot => ({ slot, productId: id(slot) }));
const artwork = Buffer.from("fixture artwork");
const env = { RENDER_ENVIRONMENT: "production", WORKER_URL: "https://forever-tee-api.socialqueue.workers.dev",
  FOREVER_TEE_API_SHARED_SECRET: "fixture-secret", FINAL_PRODUCT: "2" };
function snapshot(n) {
  return { configuredProductId: id(n), designId: id(n + 10), designRevisionId: id(n + 20),
    baseProductSlug: "staple-tee", artworkSha256: sha256(artwork), contentType: "image/png", byteSize: artwork.length,
    artworkUrl: `/v2/internal/design-revisions/${id(n + 20)}/artwork`, placement: { x: 0.2, y: 0.3, width: 0.4, depth: 2 } };
}
function api(overrides = {}) {
  const paths = [];
  return { paths, request: async (url, options) => {
    assert.equal(url.origin, env.WORKER_URL);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["x-forever-tee-service-secret"], "fixture-secret");
    paths.push(url.pathname);
    if (overrides[url.pathname]) return overrides[url.pathname](paths);
    if (url.pathname === "/v2/internal/featured-products") return Response.json({ products: featured });
    if (url.pathname.endsWith("/artwork")) return new Response(artwork);
    const n = Number(url.pathname.split("/").at(-1).split("-").at(-1));
    if (url.pathname.startsWith("/v1/designs/")) return Response.json({ id: id(n), status: "ready",
      artworkRevision: sha256(artwork), settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1 } });
    return Response.json(snapshot(n));
  } };
}

test("chooses current numbered slots and explicit UUIDs without hardcoded products", () => {
  assert.equal(selectFinalProduct(featured, "2"), id(2));
  assert.equal(selectFinalProduct(featured, id(99)), id(99));
  assert.throws(() => selectFinalProduct(featured, "6"), /not currently available/);
  assert.throws(() => selectFinalProduct(featured, "$(echo bad)"), /UUID/);
  for (const invalid of [[], [...featured, featured[0]], [{ slot: 7, productId: id(4) }]]) {
    assert.throws(() => featuredSelection(invalid));
  }
});

test("loads all original cutouts, uses final product outside, and reads only", async () => {
  const { request, paths } = api();
  const input = await loadFeaturedRenderInputs(env, request);
  assert.deepEqual(input.layers.map(layer => layer.productId), [id(2), id(3), id(1)]);
  assert.equal(input.mockupFile, "tee-white-cutout-v1.png");
  assert.ok(input.layers.every(layer => layer.artwork.equals(artwork)));
  assert.equal(paths.filter(path => path === "/v2/internal/featured-products").length, 2);
});

test("includes a nonfeatured final product and deduplicates a featured sibling", async () => {
  const input = await loadFeaturedRenderInputs({ ...env, FINAL_PRODUCT: id(4) }, api().request);
  assert.deepEqual(input.layers.map(layer => layer.productId), [id(4), id(3), id(2), id(1)]);
  const sibling = { ...snapshot(4), designId: id(12), baseProductSlug: "cotton-tote" };
  const other = await loadFeaturedRenderInputs({ ...env, FINAL_PRODUCT: id(4) }, api({
    [`/v2/internal/configured-products/${id(4)}`]: () => Response.json(sibling),
  }).request);
  assert.deepEqual(other.layers.map(layer => layer.productId), [id(4), id(3), id(1)]);
  assert.equal(other.mockupFile, "tote-black-print-bar-1001.webp");
  await assert.rejects(loadFeaturedRenderInputs({ ...env, RENDER_COLOR: "cream" }, api().request), /unavailable/);
});

test("rejects stale selection, missing assets and checksum mismatches", async () => {
  const path = `/v2/internal/design-revisions/${id(22)}/artwork`;
  for (const response of [() => new Response(artwork.subarray(1)), () => new Response("x".repeat(artwork.length)),
    () => new Response(artwork.toString() + "oversize"), () => new Response(null, { status: 404 })]) {
    await assert.rejects(loadFeaturedRenderInputs(env, api({ [path]: response }).request));
  }
  await assert.rejects(loadFeaturedRenderInputs(env, api({
    "/v2/internal/featured-products": paths => Response.json({ products: paths.length === 1 ? featured : featured.slice(1) }),
  }).request), /selection changed/);
});

test("does not send credentials to another origin or follow an artwork URL", async () => {
  await assert.rejects(loadFeaturedRenderInputs({ ...env, WORKER_URL: "https://other.example" }, () => {
    assert.fail("Unexpected network request");
  }), /WORKER_URL/);
  await assert.rejects(loadFeaturedRenderInputs(env, api({
    [`/v2/internal/configured-products/${id(2)}`]: () => Response.json({ ...snapshot(2), artworkUrl: "https://other.example/art.png" }),
  }).request), /immutable revision/);
});
