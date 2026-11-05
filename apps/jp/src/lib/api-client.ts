import { z } from 'zod';
export async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      'X-EmDash-Request': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const parsed = z
      .object({
        error: z.union([z.string(), z.object({ message: z.string() })]),
      })
      .safeParse(data);
    const message = parsed.success
      ? typeof parsed.data.error === 'string'
        ? parsed.data.error
        : parsed.data.error.message
      : 'Request failed';
    throw new Error(message);
  }
  return data;
}
