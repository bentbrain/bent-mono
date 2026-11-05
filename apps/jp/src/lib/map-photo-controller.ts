import { mapPhoto } from './responsive-image';

type Options = {
  url: string;
  poster: string;
  ready: (photo: ReturnType<typeof mapPhoto>) => void;
  failed: () => void;
  request?: (url: string, init: RequestInit) => Promise<Response>;
};

// One effect owns one attempt. Cleanup invalidates completion even when a
// transport ignores abort or JSON parsing finishes after the deadline.
export function resolveMapPhoto({
  url,
  poster,
  ready,
  failed,
  request = fetch,
}: Options) {
  const controller = new AbortController();
  let current = true;
  const deadline = setTimeout(() => {
    current = false;
    controller.abort();
    failed();
  }, 8000);
  async function resolve() {
    try {
      const response = await request(url, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Photo dimensions unavailable');
      const value: unknown = await response.json();
      let dimensions: { width: number; height: number } | undefined;
      if (value !== null) {
        if (
          typeof value !== 'object' ||
          !('width' in value) ||
          !('height' in value) ||
          typeof value.width !== 'number' ||
          typeof value.height !== 'number' ||
          !Number.isSafeInteger(value.width) ||
          !Number.isSafeInteger(value.height) ||
          value.width <= 0 ||
          value.height <= 0
        )
          throw new Error('Invalid photo dimensions');
        dimensions = { width: value.width, height: value.height };
      }
      if (current) ready(mapPhoto(poster, dimensions));
    } catch {
      if (current) failed();
    } finally {
      clearTimeout(deadline);
    }
  }
  // Coalesce rapid next/previous actions without starting obsolete lookups.
  const timer = setTimeout(() => {
    void resolve();
  }, 60);
  return () => {
    current = false;
    clearTimeout(timer);
    clearTimeout(deadline);
    controller.abort();
  };
}
