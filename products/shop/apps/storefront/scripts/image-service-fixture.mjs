import sharp from "sharp";

export async function imageService(request, record) {
  if (new URL(request.url).pathname.endsWith("/info")) {
    const bytes = Buffer.from(await request.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    return Response.json({
      format: `image/${meta.format === "jpg" ? "jpeg" : meta.format}`,
      width: meta.autoOrient.width,
      height: meta.autoOrient.height,
      fileSize: bytes.length,
    });
  }
  const { image, options } = await request.json();
  let bytes = await render(image);
  const pipeline = sharp(bytes);
  if (options.format === "image/webp")
    bytes = await pipeline.webp({ quality: options.quality ?? 90 }).toBuffer();
  else if (options.format === "image/jpeg")
    bytes = await pipeline
      .flatten({ background: "white" })
      .jpeg({ quality: options.quality ?? 90 })
      .toBuffer();
  else bytes = await pipeline.png().toBuffer();
  const metadata = await sharp(bytes).metadata();
  record.push({
    operation: "images-output",
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    bytes: bytes.length,
    syntheticSegmentation: true,
  });
  return new Response(bytes, { headers: { "content-type": options.format } });
}
async function render(image) {
  let bytes = await sharp(Buffer.from(image.source, "base64"))
    .autoOrient()
    .png()
    .toBuffer();
  for (const step of image.steps) {
    if (step.draw) {
      const overlay = await render(step.draw);
      bytes = await sharp(bytes)
        .composite([
          {
            input: overlay,
            left: step.options.left ?? 0,
            top: step.options.top ?? 0,
          },
        ])
        .png()
        .toBuffer();
    } else {
      const options = step.transform;
      const metadata = await sharp(bytes).metadata();
      if (options.trim) {
        const { left = 0, top = 0, right = 0, bottom = 0 } = options.trim;
        bytes = await sharp(bytes)
          .extract({
            left,
            top,
            width: metadata.width - left - right,
            height: metadata.height - top - bottom,
          })
          .png()
          .toBuffer();
      } else if (options.width || options.height) {
        bytes = await sharp(bytes)
          .resize({
            width: options.width,
            height: options.height,
            fit: options.fit === "scale-down" ? "inside" : "fill",
            withoutEnlargement: options.fit === "scale-down",
          })
          .png()
          .toBuffer();
      }
      if (options.segment) {
        // Explicit synthetic segmentation: retain the generated central figure.
        const meta = await sharp(bytes).metadata();
        const mask = Buffer.from(
          `<svg width="${meta.width}" height="${meta.height}"><ellipse cx="${meta.width / 2}" cy="${meta.height / 2}" rx="${meta.width * 0.42}" ry="${meta.height * 0.48}" fill="white"/></svg>`,
        );
        bytes = await sharp(bytes)
          .ensureAlpha()
          .composite([{ input: mask, blend: "dest-in" }])
          .png()
          .toBuffer();
      }
      if (options.background)
        bytes = await sharp(bytes)
          .flatten({ background: options.background })
          .png()
          .toBuffer();
    }
  }
  return bytes;
}
