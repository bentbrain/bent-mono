// These limits are shared by all isolates, unlike per-instance counters. The
// row contains operational timestamps only, never provider credentials or PII.
export async function takeProviderToken(
  db: D1Database,
  provider: "printify" | "portrait",
  now = Date.now(),
) {
  // A new design may process both a background preview and the final upload.
  const rate = provider === "printify" ? 8 / 1000 : 240 / 60_000;
  const burst = provider === "printify" ? 16 : 40;
  const rows = await db.batch<Record<string, unknown>>([
    db.prepare(`INSERT INTO provider_admission (provider, tokens, updated_at, blocked_until)
      VALUES (?, ?, ?, 0) ON CONFLICT (provider) DO NOTHING`).bind(provider, burst, now),
    db.prepare(`UPDATE provider_admission
      SET tokens = min(?, tokens + max(0, ? - updated_at) * ?) - 1, updated_at = max(updated_at, ?)
      WHERE provider = ? AND blocked_until <= ?
        AND min(?, tokens + max(0, ? - updated_at) * ?) >= 1
      RETURNING provider`).bind(burst, now, rate, now, provider, now, burst, now, rate),
    db.prepare("SELECT blocked_until FROM provider_admission WHERE provider = ?").bind(provider),
  ]);
  const blocked = rows[2]?.results[0]?.["blocked_until"];
  return { allowed: rows[1]?.meta.changes === 1,
    retryAfterSeconds: typeof blocked === "number" && blocked > now ? Math.ceil((blocked - now) / 1000) : 1 };
}

export async function deferProvider(db: D1Database, seconds: number, now = Date.now()) {
  const delay = Math.min(Math.max(Number.isFinite(seconds) ? seconds : 60, 1), 86400);
  await db.prepare(`UPDATE provider_admission SET blocked_until = max(blocked_until, ?)
    WHERE provider = 'printify'`).bind(now + delay * 1000).run();
}
