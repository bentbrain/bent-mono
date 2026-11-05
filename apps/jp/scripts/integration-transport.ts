// workerd can reset Miniflare's internal socket when an early rejection leaves
// a body unread through a service binding: cloudflare/workerd#7634. This helper
// is installed only by the ephemeral dev test integration, never in a build.
// Keep the application's response and read only bounded synthetic error bodies.
export async function drainDeniedRequest(request: Request, response: Response) {
  if (
    response.status < 400 ||
    response.status >= 500 ||
    !request.body ||
    request.bodyUsed
  )
    return response;

  const reader = request.body.getReader();
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Synthetic rejected request body timed out'));
      void reader.cancel();
    }, 1000);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024)
        throw new Error('Synthetic rejected request exceeds transport limit');
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
    reader.releaseLock();
  }
  return response;
}
