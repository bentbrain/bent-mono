import type { D1Database } from '@cloudflare/workers-types';
import { displayPreviewKey, previewPath } from './responsive-image';

// Matches the documented Images binding API using the app's DOM Web Streams.
// The Workers package declares a different ReadableStream type at this boundary.
export interface DisplayImagesBinding {
  input(stream: ReadableStream<Uint8Array>): {
    transform(options: { width: number; height: number; fit: 'scale-down' }): {
      output(options: {
        format: 'image/jpeg' | 'image/webp';
        quality: number;
        anim: boolean;
      }): Promise<{ response(): Response }>;
    };
  };
}
interface ByteStream {
  cancel(): Promise<void>;
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}
function webStream(source: ByteStream) {
  const reader = source.getReader();
  let released = false;
  function release() {
    if (released) return;
    released = true;
    reader.releaseLock();
  }
  async function cancel(reason?: unknown) {
    if (released) return;
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  }
  return {
    // Keep cancellation with the source reader, even if IMAGES locks the
    // adapter before rejecting. Cancelling a locked adapter itself would fail.
    cancel,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            release();
          } else if (chunk.value) controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          release();
        }
      },
      cancel,
    }),
  };
}
interface PreviewBucket {
  get(key: string): Promise<{
    body: ByteStream;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
}
const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Accept',
};
export function imageUnavailable(status = 404) {
  return new Response(status === 404 ? 'Not found' : 'Image unavailable', {
    status,
    headers: privateHeaders,
  });
}
export async function serveResponsiveImage(
  request: Request,
  path: string,
  env: { DB: D1Database; MEDIA: PreviewBucket; IMAGES: DisplayImagesBinding },
  privateRender: boolean,
) {
  const match = previewPath.exec(path);
  // Never use owner privileges or preview tokens to bypass live membership.
  if (
    !match ||
    privateRender ||
    !['GET', 'HEAD'].includes(request.method) ||
    new URL(request.url).search
  )
    return imageUnavailable();
  const [, , id, folder, filename, width, output] = match;
  if (!id && (!folder || !filename)) return imageUnavailable();
  const key = id || `trip/${folder || ''}/${filename || ''}.jpg`;
  try {
    const livePreview = () =>
      env.DB.prepare(
        `
      SELECT a.storage_key FROM media a JOIN ec_media_items m ON
        (m.kind='photo' AND a.id=json_extract(CASE WHEN json_valid(m.asset) THEN m.asset END,'$.id')) OR
        (m.kind='video' AND a.id=json_extract(CASE WHEN json_valid(m.poster) THEN m.poster END,'$.id'))
      WHERE a.${id ? 'id' : 'storage_key'}=? AND a.mime_type='image/jpeg'
        AND m.status='published' AND m.deleted_at IS NULL LIMIT 1
    `,
      )
        .bind(key)
        .first<{ storage_key: string }>();
    const current = await livePreview();
    if (!current || !displayPreviewKey.test(current.storage_key))
      return imageUnavailable();
    const source = await env.MEDIA.get(current.storage_key);
    if (!source) return imageUnavailable();
    if (source.size <= 0 || source.httpMetadata?.contentType !== 'image/jpeg') {
      await source.body.cancel();
      return imageUnavailable(422);
    }
    if (request.method === 'HEAD') {
      await source.body.cancel();
      const live = await livePreview();
      if (live?.storage_key !== current.storage_key) return imageUnavailable();
      return new Response(null, { headers: privateHeaders });
    }
    // Native uploads permit larger display previews than the bounded transform
    // input. Preserve their availability by streaming the existing live preview.
    if (source.size > 16 * 1024 * 1024) {
      const live = await livePreview();
      if (live?.storage_key !== current.storage_key) {
        await source.body.cancel();
        return imageUnavailable();
      }
      return new Response(webStream(source.body).stream, {
        headers: { ...privateHeaders, 'Content-Type': 'image/jpeg' },
      });
    }
    const acceptsWebp = (request.headers.get('Accept') || '')
      .split(',')
      .some((value) => {
        const [type, ...parameters] = value.trim().split(';');
        return (
          type === 'image/webp' &&
          !parameters.some((parameter) =>
            /^\s*q=0(?:\.0*)?\s*$/.test(parameter),
          )
        );
      });
    const format =
      output === 'webp' || (output === 'auto' && acceptsWebp)
        ? 'image/webp'
        : 'image/jpeg';
    const input = webStream(source.body);
    let transformed: Response | undefined;
    try {
      const result = await env.IMAGES.input(input.stream)
        .transform({ width: Number(width), height: 1600, fit: 'scale-down' })
        .output({ format, quality: 75, anim: false });
      transformed = result.response();
      if (
        !transformed.ok ||
        !transformed.body ||
        transformed.headers.get('Content-Type') !== format
      )
        throw new Error('Image transform failed');
      const live = await livePreview();
      if (live?.storage_key !== current.storage_key) {
        await Promise.allSettled([transformed.body.cancel(), input.cancel()]);
        return imageUnavailable();
      }
      return new Response(transformed.body, {
        headers: { ...privateHeaders, 'Content-Type': format },
      });
    } catch {
      // Neither a rejected output nor an abandoned transform input is returned.
      // Cleanup failures must not prevent an otherwise eligible fallback.
      await Promise.allSettled([input.cancel(), transformed?.body?.cancel()]);
      // Check both sides of the R2 wait. Publication or the storage key can
      // change while either the transform or fallback read is pending.
      const live = await livePreview();
      if (live?.storage_key !== current.storage_key) return imageUnavailable();
      const fallback = await env.MEDIA.get(current.storage_key);
      if (!fallback) return imageUnavailable();
      if (
        fallback.size <= 0 ||
        fallback.httpMetadata?.contentType !== 'image/jpeg'
      ) {
        await fallback.body.cancel();
        return imageUnavailable(422);
      }
      let final;
      try {
        final = await livePreview();
      } catch (error) {
        await fallback.body.cancel();
        throw error;
      }
      if (final?.storage_key !== current.storage_key) {
        await fallback.body.cancel();
        return imageUnavailable();
      }
      return new Response(webStream(fallback.body).stream, {
        headers: { ...privateHeaders, 'Content-Type': 'image/jpeg' },
      });
    }
  } catch {
    return imageUnavailable(503);
  }
}
