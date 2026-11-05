// The binding consumes standard Web Streams. Keep this boundary in the
// project's DOM types rather than mixing two incompatible Stream declarations.
export interface NewsletterImagesBinding {
  input(stream: ReadableStream<Uint8Array>): {
    transform(options: { width: number; height: number; fit: 'scale-down' }): {
      output(options: {
        format: 'image/jpeg';
        quality: number;
        background: string;
        anim: boolean;
      }): Promise<{
        response(): { arrayBuffer(): Promise<ArrayBuffer> };
      }>;
    };
  };
}

export interface NewsletterJpeg {
  bytes: Uint8Array;
  width: number;
  height: number;
}

// Remove EXIF, XMP, ICC, IPTC and comments after Cloudflare applies orientation
// and colour conversion. Keep the JFIF and Adobe colour-encoding markers.
export function newsletterJpeg(bytes: Uint8Array): NewsletterJpeg {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error('Newsletter image is not a JPEG');
  const pieces = [bytes.subarray(0, 2)];
  let position = 2;
  let width = 0;
  let height = 0;
  let scan = false;
  let ended = false;
  while (position < bytes.length) {
    const start = position;
    if (bytes[position++] !== 0xff) throw new Error('Invalid newsletter JPEG');
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === 0xd9) {
      pieces.push(bytes.subarray(start, position));
      ended = position === bytes.length;
      break;
    }
    if (marker === undefined || position + 2 > bytes.length)
      throw new Error('Invalid newsletter JPEG');
    const length = (bytes[position] ?? 0) * 256 + (bytes[position + 1] ?? 0);
    if (length < 2 || position + length > bytes.length)
      throw new Error('Invalid newsletter JPEG');
    if (marker === 0xc0 || marker === 0xc2) {
      if (length < 8) throw new Error('Invalid newsletter JPEG dimensions');
      height = (bytes[position + 3] ?? 0) * 256 + (bytes[position + 4] ?? 0);
      width = (bytes[position + 5] ?? 0) * 256 + (bytes[position + 6] ?? 0);
    }
    const metadata =
      (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!metadata) pieces.push(bytes.subarray(start, position + length));
    position += length;
    if (marker === 0xda) {
      scan = true;
      const scanStart = position;
      // Entropy bytes escape FF as FF00; restart markers stay inside the scan.
      // Resume marker parsing between progressive scans so metadata cannot hide
      // after the first scan header.
      while (position < bytes.length) {
        if (bytes[position] !== 0xff) {
          position++;
          continue;
        }
        const next = bytes[position + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7))
          position += 2;
        else break;
      }
      pieces.push(bytes.subarray(scanStart, position));
    }
  }
  if (
    !scan ||
    !ended ||
    !width ||
    !height ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  )
    throw new Error('Incomplete newsletter JPEG');
  const result = new Uint8Array(
    pieces.reduce((size, piece) => size + piece.length, 0),
  );
  let offset = 0;
  for (const piece of pieces) {
    result.set(piece, offset);
    offset += piece.length;
  }
  return { bytes: result, width, height };
}

function newsletterByteStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function optimiseNewsletterImage(
  images: NewsletterImagesBinding,
  source: Uint8Array,
): Promise<NewsletterJpeg> {
  if (!source.length || source.length > 16 * 1024 * 1024)
    throw new Error('Newsletter source image is too large');
  for (const { width, quality } of [
    { width: 1120, quality: 75 },
    { width: 1120, quality: 65 },
    { width: 960, quality: 65 },
    { width: 840, quality: 55 },
    { width: 640, quality: 50 },
  ]) {
    const transformed = await images
      .input(newsletterByteStream(source))
      .transform({ width, height: 3360, fit: 'scale-down' })
      .output({
        format: 'image/jpeg',
        quality,
        background: '#ffffff',
        anim: false,
      });
    const response = transformed.response();
    const result = newsletterJpeg(new Uint8Array(await response.arrayBuffer()));
    if (result.width > width || result.height > 3360)
      throw new Error('Newsletter image dimensions exceed the limit');
    if (result.bytes.length <= 150_000) return result;
  }
  throw new Error('Newsletter image could not fit the email size limit');
}
