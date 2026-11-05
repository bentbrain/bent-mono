import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PRODUCT_MOCKUP_GEOMETRY } from "@forever-tee/contracts/product-mockup-geometry";
export const RENDERER_VERSION = "product-images-v5";
export function parseImageRecipe(v) {
  if (
    !v ||
    typeof v !== "object" ||
    !["staple-tee", "cotton-tote"].includes(v.baseProductSlug) ||
    !["flat", "lifestyle"].includes(v.view) ||
    !["recursive", "base-image-only"].includes(v.printMode) ||
    !(
      v.baseProductSlug === "staple-tee"
        ? ["White", "Black"]
        : ["Cream", "Black"]
    ).includes(v.color) ||
    (v.view === "lifestyle" && v.baseProductSlug !== "staple-tee") ||
    typeof v.storageKey !== "string" ||
    !/^designs\/[a-f0-9-]{36}\/product-images\/v5\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/(black|white|cream)-(flat|lifestyle)\.webp$/.test(
      v.storageKey,
    ) ||
    !v.storageKey.endsWith(`/${v.color.toLowerCase()}-${v.view}.webp`)
  )
    throw new Error("Invalid image recipe.");
  const s = v.settings;
  if (
    !s ||
    typeof s !== "object" ||
    ![
      "cropX",
      "cropY",
      "cropZoom",
      "depth",
      "placementX",
      "placementY",
      "placementWidth",
    ].every((k) => typeof s[k] === "number" && Number.isFinite(s[k])) ||
    s.cropX < 0 ||
    s.cropX > 1 ||
    s.cropY < 0 ||
    s.cropY > 1 ||
    s.cropZoom < 0.65 ||
    s.cropZoom > 2.6 ||
    !Number.isInteger(s.depth) ||
    s.depth < 0 ||
    s.depth > 8 ||
    s.placementWidth < 0.08 ||
    s.placementWidth > 0.48 ||
    s.placementX < 0 ||
    s.placementY < 0 ||
    s.placementX + s.placementWidth > 1.000001 ||
    s.placementY + s.placementWidth > 1.000001
  )
    throw new Error("Invalid image placement.");
  return {
    baseProductSlug: v.baseProductSlug,
    color: v.color,
    view: v.view,
    printMode: v.printMode,
    storageKey: v.storageKey,
    settings: { ...s },
  };
}
const templates = new Map();
async function template(directory, color, kind) {
  const key = `${directory}/${color}/${kind}`;
  if (!templates.has(key)) {
    const load = (async () => {
      const manifest = JSON.parse(
        await readFile(join(directory, "server-manifest.json"), "utf8"),
      );
      if (kind === "flat")
        return readFile(join(directory, manifest.flats[color]));
      const spec = manifest.lifestyle[color];
      const images = await Promise.all(
        ["base.webp", "geometry.png", "light.png"].map((suffix) =>
          sharp(join(directory, `${spec.prefix}-${suffix}`))
            .ensureAlpha()
            .raw()
            .toBuffer(),
        ),
      );
      return { ...spec, images };
    })();
    templates.set(key, load);
    void load.catch(() => templates.delete(key));
  }
  return templates.get(key);
}
async function place(source, s, width, height, depth) {
  const image = sharp(source, { limitInputPixels: 40_000_000 }),
    meta = await image.metadata();
  if (!meta.width || !meta.height)
    throw new Error("Missing artwork dimensions.");
  const scale = Math.min(width / meta.width, height / meta.height) * s.cropZoom;
  const rw = Math.max(1, Math.round(meta.width * scale)),
    rh = Math.max(1, Math.round(meta.height * scale));
  const left = Math.round(width / 2 - s.cropX * rw),
    top = Math.round(height / 2 - s.cropY * rh);
  const x = Math.max(0, -left),
    y = Math.max(0, -top),
    w = Math.min(rw - x, width - Math.max(0, left)),
    h = Math.min(rh - y, height - Math.max(0, top));
  if (w <= 0 || h <= 0) throw new Error("Artwork outside print canvas.");
  const clipped = await image
    .resize(rw, rh, { fit: "fill" })
    .extract({ left: x, top: y, width: w, height: h })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const raw = { width, height, channels: 4 };
  const base = await sharp({
    create: { ...raw, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: clipped,
        raw: { width: w, height: h, channels: 4 },
        left: Math.max(0, left),
        top: Math.max(0, top),
      },
    ])
    .raw()
    .toBuffer();
  let previous = base;
  for (let level = 0; level < depth; level++) {
    const nw = Math.max(1, Math.round(s.placementWidth * width)),
      nh = Math.max(1, Math.round((nw * height) / width));
    const nested = await sharp(previous, { raw })
      .resize(nw, nh, { fit: "fill" })
      .raw()
      .toBuffer();
    previous = await sharp(base, { raw })
      .composite([
        {
          input: nested,
          raw: { width: nw, height: nh, channels: 4 },
          left: Math.min(width - nw, Math.round(s.placementX * width)),
          top: Math.min(height - nh, Math.round(s.placementY * height)),
        },
      ])
      .raw()
      .toBuffer();
  }
  return previous;
}
let compiled;
async function displace(ink, width, height, images, tint) {
  compiled ??= readFile(
    new URL("../assets/displacement.wasm", import.meta.url),
  ).then((bytes) => WebAssembly.compile(bytes));
  // Own linear memory per render. Concurrent requests cannot mutate another job's buffers.
  const api = new WebAssembly.Instance(await compiled, {}).exports;
  if (
    !(api.memory instanceof WebAssembly.Memory) ||
    typeof api.alloc !== "function" ||
    typeof api.displace !== "function"
  )
    throw new Error("Invalid compositor module.");
  const copy = (data) => {
    const p = api.alloc(data.length);
    new Uint8Array(api.memory.buffer, p, data.length).set(data);
    return p;
  };
  const source = copy(ink),
    [base, map, light] = images.map(copy),
    out = api.alloc(768 * 1024 * 4);
  api.displace(source, width, height, base, map, light, out, ...tint);
  return new Uint8Array(api.memory.buffer, out, 768 * 1024 * 4).slice();
}
export async function renderProductDisplay(artwork, recipe, assetDirectory) {
  const job = parseImageRecipe(recipe),
    geometry = PRODUCT_MOCKUP_GEOMETRY[job.baseProductSlug];
  const spec = await template(
    assetDirectory,
    job.view === "flat"
      ? `${job.baseProductSlug}-${job.color.toLowerCase()}`
      : job.color.toLowerCase(),
    job.view,
  );
  const width =
      job.view === "flat"
        ? Math.round(768 * geometry.mockup.width)
        : spec.inkWidth,
    height = Math.round(
      (width * geometry.canvas.heightPx) / geometry.canvas.widthPx,
    );
  const ink = await place(
    artwork,
    job.settings,
    width,
    height,
    job.printMode === "base-image-only" ? 0 : job.settings.depth,
  );
  const image =
    job.view === "flat"
      ? sharp(spec).composite([
          {
            input: ink,
            raw: { width, height, channels: 4 },
            left: Math.round(768 * geometry.mockup.left),
            top: Math.round(768 * geometry.mockup.top),
          },
        ])
      : sharp(await displace(ink, width, height, spec.images, spec.lightTint), {
          raw: { width: 768, height: 1024, channels: 4 },
        });
  return image.webp({ quality: 90, alphaQuality: 100 }).toBuffer();
}
