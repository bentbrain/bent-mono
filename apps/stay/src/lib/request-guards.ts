// Per-instance abuse mitigation. A shared Redis limiter is needed for a public service.
const attempts = new Map<string, { count: number; expires: number }>();
export function allowRequest(key: string, max: number, windowMs: number) {
  const now = Date.now();
  for (const [id, value] of attempts)
    if (value.expires <= now) attempts.delete(id);
  const existing = attempts.get(key);
  if (existing) {
    existing.count++;
    return existing.count <= max;
  }
  if (attempts.size >= 5000) return false;
  attempts.set(key, { count: 1, expires: now + windowMs });
  return true;
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}
