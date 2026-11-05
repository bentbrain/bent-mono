import sharp from 'sharp';

// Pixel-test adapter only. Cloudflare timing and output require cloud qualification.
const readBytes = async stream => Buffer.from(await new Response(stream).arrayBuffer());

class Transformer {
  constructor(source, record) {
    this.source = source;
    this.record = record;
    this.steps = [];
  }

  transform(options) {
    this.steps.push({ options });
    return this;
  }

  draw(input, options) {
    this.steps.push({ input, options });
    return this;
  }

  async rendered() {
    let current = await this.source;
    for (const step of this.steps) {
      if (step.input) {
        const overlay = step.input instanceof Transformer
          ? await step.input.rendered() : await readBytes(step.input);
        current = await sharp(current).composite([{
          input: overlay, left: step.options.left, top: step.options.top,
        }]).png().toBuffer();
      } else if (step.options.trim) {
        const metadata = await sharp(current).metadata();
        const trim = step.options.trim;
        current = await sharp(current).extract({
          left: trim.left, top: trim.top,
          width: metadata.width - trim.left - trim.right,
          height: metadata.height - trim.top - trim.bottom,
        }).png().toBuffer();
      } else {
        current = await sharp(current)
          .resize(step.options.width, step.options.height, { fit: 'fill' }).png().toBuffer();
      }
    }
    return current;
  }

  async output() {
    const rendered = await this.rendered();
    const metadata = await sharp(rendered).metadata();
    this.record.push({ width: metadata.width, height: metadata.height, bytes: rendered.length });
    return { response: () => new Response(rendered) };
  }
}

export function sharpPrintImages() {
  const record = [];
  return {
    record,
    input: stream => new Transformer(readBytes(stream), record),
    info: async stream => {
      const bytes = await readBytes(stream);
      const metadata = await sharp(bytes).metadata();
      return { format: 'image/png', width: metadata.width, height: metadata.height, fileSize: bytes.length };
    },
  };
}
