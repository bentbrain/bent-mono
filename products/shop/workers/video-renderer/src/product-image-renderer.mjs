import sharp from "sharp";
import { PRODUCT_MOCKUP_GEOMETRY } from "./product-mockup-geometry.mjs";
import { renderLifestyle } from "./lifestyle.mjs";

export async function renderProductImage({artwork, mockup, template, baseProductSlug, settings, printMode, view}) {
  const geometry = PRODUCT_MOCKUP_GEOMETRY[baseProductSlug];
  if (!geometry) throw new Error("Unknown product geometry.");
  const width = view === "lifestyle" ? 1000 : Math.round(1500 * geometry.mockup.width);
  const placed = await renderRecursiveArtwork(artwork, settings, printMode,
    {width, height:Math.round(width * geometry.canvas.heightPx / geometry.canvas.widthPx)});
  if (view === "lifestyle") {
    if (baseProductSlug !== "staple-tee" || !template) throw new Error("Lifestyle template unavailable.");
    if (!Buffer.isBuffer(template.mask)) throw new Error("Lifestyle garment mask unavailable.");
    return (await renderLifestyle({...template, base:mockup, lighting:mockup, artwork:placed, format:"webp", diagnostics:false})).image;
  }
  return sharp(mockup).resize(1500,1500).composite([{input:placed,
    left:Math.round(1500 * geometry.mockup.left), top:Math.round(1500 * geometry.mockup.top)}])
    .webp({quality:90, alphaQuality:100, smartSubsample:true}).toBuffer();
}

async function renderRecursiveArtwork(source, settings, printMode, canvas) {
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("The design artwork dimensions are unavailable.");
  }

  const containScale = Math.min(
    canvas.width / metadata.width,
    canvas.height / metadata.height,
  );
  const scale = containScale * settings.cropZoom;
  const resizedWidth = Math.max(1, Math.round(metadata.width * scale));
  const resizedHeight = Math.max(1, Math.round(metadata.height * scale));
  const resized = await sharp(source)
    .resize({ width: resizedWidth, height: resizedHeight, fit: "fill" })
    .png()
    .toBuffer();
  const left = Math.round(canvas.width / 2 - settings.cropX * resizedWidth);
  const top = Math.round(canvas.height / 2 - settings.cropY * resizedHeight);
  const sourceLeft = Math.max(0, -left);
  const sourceTop = Math.max(0, -top);
  const clippedWidth = Math.min(
    resizedWidth - sourceLeft,
    canvas.width - Math.max(0, left),
  );
  const clippedHeight = Math.min(
    resizedHeight - sourceTop,
    canvas.height - Math.max(0, top),
  );
  if (clippedWidth <= 0 || clippedHeight <= 0) {
    throw new Error("The design artwork crop is outside the preview.");
  }
  const clipped = await sharp(resized)
    .extract({
      left: sourceLeft,
      top: sourceTop,
      width: clippedWidth,
      height: clippedHeight,
    })
    .png()
    .toBuffer();
  const base = await sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: clipped, left: Math.max(0, left), top: Math.max(0, top) },
    ])
    .png()
    .toBuffer();

  const placementWidth = Math.max(
    1,
    Math.round(settings.placementWidth * canvas.width),
  );
  const placementHeight = Math.max(
    1,
    Math.round(placementWidth * (canvas.height / canvas.width)),
  );
  let previous = base;
  for (let level = 0; level < (printMode === "base-image-only" ? 0 : settings.depth); level += 1) {
    const nested = await sharp(previous)
      .resize({ width: placementWidth, height: placementHeight, fit: "fill" })
      .png()
      .toBuffer();
    previous = await sharp(base)
      .composite([
        {
          input: nested,
          left: Math.round(settings.placementX * canvas.width),
          top: Math.round(settings.placementY * canvas.height),
        },
      ])
      .png()
      .toBuffer();
  }
  return previous;
}
