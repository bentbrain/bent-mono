import { z } from 'zod';

const proxyError = z.object({ message: z.string(), stack: z.string() });
export function isDevProxyDispatchError(
  status: number,
  contentType: string,
  body: string,
) {
  if (status !== 500 || (contentType && !contentType.includes('text/html')))
    return false;
  const serialized = /const error = (\{[^\n]+\})/.exec(body)?.[1];
  if (!serialized) return false;
  try {
    const value: unknown = JSON.parse(serialized);
    const error = proxyError.safeParse(value);
    return (
      error.success &&
      error.data.message === 'fetch failed' &&
      error.data.stack.includes('_Miniflare.dispatchFetch') &&
      error.data.stack.includes('@cloudflare/vite-plugin')
    );
  } catch {
    return false;
  }
}

const markers = [
  ['dependency-bundling', '[optimizer] bundling dependencies'],
  ['dependency-reoptimization', 'Re-optimizing dependencies'],
  ['dependency-reload', 'optimized dependencies changed'],
  ['proxy-dispatch', '_Miniflare.dispatchFetch'],
  ['fetch-failed', 'fetch failed'],
  ['d1-error', 'D1_ERROR'],
  ['sqlite-busy', 'SQLITE_BUSY'],
  ['missing-table', 'no such table'],
  ['worker-reload', 'Reloading local server'],
  ['worker-export-restart', 'Worker exports have changed'],
  ['dev-server-restart', 'Restarting dev server'],
  ['worker-crash', 'workerd restarted after a crash'],
];
export function serverSignals(output: string) {
  return markers.flatMap(([name, marker]) =>
    name && marker && output.includes(marker) ? [name] : [],
  );
}

// Never print bodies, headers, cookies or raw server output. These fixed
// classifications distinguish a failed dev proxy from application responses.
export async function assertStatus(
  response: Response,
  expected: number | 'below 500',
  operation: string,
  signals: { atMs: number; signals: string[] }[],
) {
  if (
    expected === 'below 500'
      ? response.status < 500
      : response.status === expected
  )
    return;
  const body = await response.text();
  const contentType = response.headers.get('Content-Type') || '';
  throw new Error(
    JSON.stringify({
      operation,
      expected,
      actual: response.status,
      html:
        contentType.includes('text/html') ||
        body.trimStart().startsWith('<!DOCTYPE html>'),
      overlay: /const error = (\{[^\n]+\})/.test(body),
      json: contentType.includes('application/json'),
      bodyBytes: new TextEncoder().encode(body).length,
      devProxyDispatch: isDevProxyDispatchError(
        response.status,
        contentType,
        body,
      ),
      responseSignals: serverSignals(body),
      serverSignals: signals.slice(-20),
    }),
  );
}
