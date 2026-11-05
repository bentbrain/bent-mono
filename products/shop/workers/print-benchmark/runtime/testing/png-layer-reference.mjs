import sharp from 'sharp';

// Frozen pre-optimization renderer for differential tests and local timing only.
export async function renderPrint(source, plan) {
  const layers = [];
  for (const layer of plan.layers) {
    const input = await sharp(source, { limitInputPixels: 144000000 }).resize(layer.width, layer.height, { fit: 'fill' })
      .extract({ left: layer.trimLeft, top: layer.trimTop,
        width: layer.width - layer.trimLeft - layer.trimRight, height: layer.height - layer.trimTop - layer.trimBottom })
      .png().toBuffer();
    layers.push({ input, left: layer.destinationLeft, top: layer.destinationTop });
  }
  return sharp({ create: { width: plan.width, height: plan.height, channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
}
