import type { D1Database } from '@cloudflare/workers-types';
import { displayPreviewKey, previewPath } from './responsive-image';

interface HeaderBucket {
  get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<{
    httpMetadata?: { contentType?: string };
    body: {
      cancel(): Promise<void>;
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        cancel(reason?: unknown): Promise<void>;
        releaseLock(): void;
      };
    };
  } | null>;
}

class HeaderTimeout extends Error {}

async function readHeader(
  bucket: HeaderBucket,
  key: string,
  signal: AbortSignal,
) {
  let stopped = false;
  const inactive = () => stopped;
  let cleanup = () => {};
  let stop = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => {
      stopped = true;
      cleanup();
      reject(new HeaderTimeout());
    };
  });
  const deadline = setTimeout(stop, 4000);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const read = async () => {
    if (inactive()) return;
    const header = await bucket.get(key, {
      range: { offset: 0, length: 65536 },
    });
    if (!header) return;
    if (inactive() || header.httpMetadata?.contentType !== 'image/jpeg') {
      // R2 get has no abort option. Dispose its body if it arrives after expiry.
      void header.body.cancel().catch(() => {});
      return;
    }
    const reader = header.body.getReader();
    let cancelled = false;
    cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      // Cancellation itself may wait on the source. Never let it hold a response.
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // A failed cancellation must not prevent deadline completion.
      }
      try {
        reader.releaseLock();
      } catch {
        // Some streams retain their lock while a pending read is cancelled.
      }
    };
    try {
      const bytes = new Uint8Array(65536);
      let length = 0;
      while (!inactive() && length < bytes.length) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value) {
          const part = chunk.value.subarray(0, bytes.length - length);
          bytes.set(part, length);
          length += part.length;
          const dimensions = jpegDimensions(bytes.subarray(0, length));
          if (!inactive() && dimensions) return dimensions;
        }
      }
    } finally {
      cleanup();
    }
  };
  try {
    return await Promise.race([read(), interrupted]);
  } finally {
    stopped = true;
    clearTimeout(deadline);
    signal.removeEventListener('abort', stop);
    cleanup();
  }
}

// Prepared display JPEGs have their frame header before the compressed scan.
// Read only a bounded prefix of the selected public display, never an original.
export function jpegDimensions(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return;
    const length = (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (length < 8) return;
      const height = (bytes[offset + 3] ?? 0) * 256 + (bytes[offset + 4] ?? 0);
      const width = (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0);
      return width && height ? { width, height } : undefined;
    }
    offset += length;
  }
}

export async function serveMapPhoto(
  request: Request,
  path: string,
  env: { DB: D1Database; MEDIA: HeaderBucket },
  privateRender: boolean,
) {
  const headers = {
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const unavailable = (status = 404) =>
    new Response('Photo unavailable', { status, headers });
  const cancelled = () => request.signal.aborted;
  const match = /^\/map-photo\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/(.+)$/.exec(path);
  if (
    !match ||
    request.method !== 'GET' ||
    privateRender ||
    new URL(request.url).search ||
    cancelled()
  )
    return unavailable();
  const [, id, reference] = match;
  const preview = previewPath.exec(
    `/media-preview/${reference || ''}/320/auto`,
  );
  if (!preview) return unavailable();
  const [, , asset, folder, filename] = preview;
  const key = asset || `trip/${folder || ''}/${filename || ''}.jpg`;
  try {
    const live = () =>
      env.DB.prepare(
        `SELECT a.storage_key, a.width, a.height FROM media a
       JOIN ec_media_items m ON a.id=json_extract(CASE WHEN json_valid(m.asset) THEN m.asset END,'$.id')
         OR a.id=json_extract(CASE WHEN json_valid(m.poster) THEN m.poster END,'$.id')
       WHERE m.id=? AND m.kind='photo' AND m.status='published'
         AND m.deleted_at IS NULL AND a.mime_type='image/jpeg'
         AND a.${asset ? 'id' : 'storage_key'}=? LIMIT 1`,
      )
        .bind(id || '', key)
        .first<{
          storage_key: string;
          width: number | null;
          height: number | null;
        }>();
    const current = await live();
    if (!current || !displayPreviewKey.test(current.storage_key) || cancelled())
      return unavailable();
    let dimensions =
      Number.isSafeInteger(current.width) &&
      Number.isSafeInteger(current.height) &&
      current.width !== null &&
      current.height !== null &&
      current.width > 0 &&
      current.height > 0
        ? { width: current.width, height: current.height }
        : undefined;
    if (!dimensions) {
      try {
        dimensions = await readHeader(
          env.MEDIA,
          current.storage_key,
          request.signal,
        );
      } catch (error) {
        if (cancelled()) return unavailable();
        if (error instanceof HeaderTimeout) return unavailable(503);
        // Missing headers retain the live display path, after the final check.
      }
      if ((await live())?.storage_key !== current.storage_key || cancelled())
        return unavailable();
    }
    return Response.json(dimensions || null, { headers });
  } catch {
    return unavailable(503);
  }
}
