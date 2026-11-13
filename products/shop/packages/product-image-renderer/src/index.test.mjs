import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { parseImageRecipe, renderProductDisplay } from "./index.mjs";
const directory = new URL(
  "../../../apps/web/public/mockups/lifestyle-v4/",
  import.meta.url,
).pathname;
const settings = {
  cropX: 0.5,
  cropY: 0.5,
  cropZoom: 1,
  depth: 4,
  placementX: 0.39,
  placementY: 0.43,
  placementWidth: 0.22,
};
const recipe = (color, view, slug = "staple-tee") => ({
  baseProductSlug: slug,
  color,
  view,
  printMode: "recursive",
  settings,
  storageKey: `designs/11111111-1111-1111-1111-111111111111/product-images/v5/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333/${color.toLowerCase()}-${view}.webp`,
});
test("rejects unsupported variants, paths and excessive allocations before rendering", () => {
  for (const invalid of [
    { ...recipe("White", "flat"), baseProductSlug: "unknown" },
    recipe("Cream", "lifestyle"),
    { ...recipe("Black", "flat"), storageKey: "/tmp/output.webp" },
    { ...recipe("White", "flat"), settings: { ...settings, cropZoom: 100 } },
  ])
    assert.throws(() => parseImageRecipe(invalid));
});
test("renders the full 50 MP upload boundary and rejects larger sources", async () => {
  for (const format of ["jpeg", "png"]) {
    const source = await sharp({
      create: { width: 10000, height: 5000, channels: 4, background: "#126acc" },
    }).toFormat(format).toBuffer();
    const output = await renderProductDisplay(source, recipe("White", "flat"), directory);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 768);
    assert.equal(metadata.height, 768);
  }
  const oversized = await sharp({
    create: { width: 10000, height: 5001, channels: 3, background: "#126acc" },
  }).jpeg().toBuffer();
  await assert.rejects(
    renderProductDisplay(oversized, recipe("White", "flat"), directory),
    /pixel limit/,
  );
});
test("compiled displacement matches its checked-in source and binary hashes", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../assets/displacement-build.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [path, expected] of Object.entries(manifest.files))
    assert.equal(
      createHash("sha256")
        .update(await readFile(new URL("../" + path, import.meta.url)))
        .digest("hex"),
      expected,
    );
});
test("all six variants render concurrently with isolated artwork and preserve dimensions", async () => {
  const red = await sharp({
    create: { width: 250, height: 314, channels: 4, background: "#ee2200" },
  })
    .png()
    .toBuffer();
  const blue = await sharp({
    create: { width: 250, height: 314, channels: 4, background: "#0033ff" },
  })
    .png()
    .toBuffer();
  for (const color of ["White", "Black"]) {
    const r = recipe(color, "lifestyle");
    const [a, b, c] = await Promise.all([
      renderProductDisplay(red, r, directory),
      renderProductDisplay(blue, r, directory),
      renderProductDisplay(red, r, directory),
    ]);
    assert.deepEqual(a, c);
    assert.notDeepEqual(a, b);
    assert.equal((await sharp(a).metadata()).height, 1024);
    // The displacement changes ink, not the photograph outside the shirt print region.
    const m = JSON.parse(
      await readFile(directory + "server-manifest.json", "utf8"),
    );
    const base = await sharp(
      directory + m.lifestyle[color.toLowerCase()].prefix + "-base.webp",
    )
      .ensureAlpha()
      .raw()
      .toBuffer();
    const out = await sharp(a).ensureAlpha().raw().toBuffer();
    let diff = 0;
    for (let i = 0; i < 768 * 400 * 4; i++) diff += Math.abs(base[i] - out[i]);
    assert.ok(diff / (768 * 400 * 4) < 3);
  }
  await Promise.all(
    [
      recipe("White", "flat"),
      recipe("Black", "flat"),
      recipe("Cream", "flat", "cotton-tote"),
      recipe("Black", "flat", "cotton-tote"),
    ].map(async (r) => {
      const result = await renderProductDisplay(red, r, directory);
      const m = await sharp(result).metadata();
      assert.equal(m.width, 768);
      assert.equal(m.height, 768);
    }),
  );
});

test("preserves native crop, effect and displacement at display resolution", async () => {
  const { renderProductImage } = await import(
    "../../../workers/video-renderer/src/product-image-renderer.mjs"
  );
  const root = new URL("../../../", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("assets/lifestyle/featured.json", root), "utf8"),
  );
  const artwork = await sharp(
    Buffer.from(
      `<svg width="500" height="630"><rect width="500" height="630" fill="#126acc"/><circle cx="110" cy="170" r="90" fill="#ffc720"/><path d="M20 570L410 200L490 600Z" fill="#ce3451"/><rect x="310" y="80" width="160" height="80" fill="white"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  for (const color of ["White", "Black"])
    for (const view of ["flat", "lifestyle"])
      for (const printMode of ["recursive", "base-image-only"]) {
        const job = {
          ...recipe(color, view),
          printMode,
          settings: { ...settings, cropX: 0.47, cropY: 0.62, cropZoom: 1.06 },
        };
        const spec = manifest.templates.find(
          (t) => t.id === color.toLowerCase(),
        );
        const template = {
          ...spec,
          mask: await readFile(new URL(`assets/lifestyle/${spec.mask}`, root)),
        };
        const mockup = await readFile(
          new URL(
            view === "flat"
              ? `apps/web/public/mockups/tee-${color.toLowerCase()}-v1.png`
              : `assets/lifestyle/${spec.base}`,
            root,
          ),
        );
        const native = await renderProductImage({
          artwork,
          mockup,
          template,
          baseProductSlug: job.baseProductSlug,
          settings: job.settings,
          printMode,
          view,
        });
        const actual = await renderProductDisplay(artwork, job, directory);
        const expected = await sharp(native)
          .resize(768, view === "flat" ? 768 : 1024)
          .ensureAlpha()
          .raw()
          .toBuffer();
        const observed = await sharp(actual).ensureAlpha().raw().toBuffer();
        // Compare the central print area, not the unchanged photograph around it.
        let sum = 0,
          count = 0;
        const top = view === "flat" ? 240 : 500,
          bottom = view === "flat" ? 600 : 890;
        for (let y = top; y < bottom; y++)
          for (let x = 225; x < 545; x++)
            for (let c = 0; c < 3; c++) {
              const i = (y * 768 + x) * 4 + c;
              sum += Math.abs(expected[i] - observed[i]);
              count++;
            }
        assert.ok(
          sum / count < 5,
          `${color} ${view} ${printMode}: mean channel difference ${sum / count}`,
        );
      }
});
