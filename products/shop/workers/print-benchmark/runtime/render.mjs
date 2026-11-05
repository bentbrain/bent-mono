import sharp from 'sharp';

// Use the application's precomputed integer plans without approximating crop or placement.
export async function renderPrint(source, plan) {
  const inputOptions = { limitInputPixels: 144000000 };
  const metadata = await sharp(source, inputOptions).metadata();
  // Prepared artwork is unprofiled 8-bit sRGB PNG. Decode that once, preserving
  // the original decoder pipeline for profiled, higher precision or other inputs.
  const decoded = metadata.format === 'png' && metadata.space === 'srgb' && metadata.depth === 'uchar' && !metadata.icc
    ? await sharp(source, inputOptions).raw().toBuffer({ resolveWithObject: true }) : undefined;
  const layers = [];
  for (const layer of plan.layers) {
    const image = decoded ? sharp(decoded.data, { raw: {
      width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels,
    } }) : sharp(source, inputOptions);
    const resized = image.resize(layer.width, layer.height, { fit: 'fill' })
      .extract({ left: layer.trimLeft, top: layer.trimTop,
        width: layer.width - layer.trimLeft - layer.trimRight, height: layer.height - layer.trimTop - layer.trimBottom });
    if (!decoded) {
      layers.push({ input: await resized.png().toBuffer(), left: layer.destinationLeft, top: layer.destinationTop });
      continue;
    }
    const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true });
    // Raw overlays avoid a PNG encode/decode per layer. Sharp's default straight
    // alpha handling matches the previous PNG overlays; do not mark premultiplied.
    layers.push({ input: data, raw: { width: info.width, height: info.height, channels: info.channels },
      left: layer.destinationLeft, top: layer.destinationTop });
  }
  return sharp({ create: { width: plan.width, height: plan.height, channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
}
