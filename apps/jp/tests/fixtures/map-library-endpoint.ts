import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';

// Seed volume, not CMS mutation throughput. Copy a natively uploaded/published
// record in the fixture's real ephemeral D1, keeping its native R2 references.
// This endpoint is injected only by map-library.config.mjs, never the app.
export const POST: APIRoute = async (context) => {
  if (
    !import.meta.env.DEV ||
    context.url.hostname !== '127.0.0.1' ||
    context.request.method !== 'POST' ||
    !context.locals.user ||
    context.locals.user.role < 50 ||
    context.request.headers.get('X-EmDash-Request') !== '1' ||
    context.request.headers.get('Origin') !== context.url.origin
  )
    return new Response(null, { status: 404 });
  const sourceId = z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    .parse(context.url.searchParams.get('sourceId'));
  const columns = await env.DB.prepare(
    'PRAGMA table_info(ec_media_items)',
  ).all<{
    name: string;
  }>();
  const names = columns.results.map(({ name }) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(name))
      throw new Error('Unexpected fixture column');
    return `"${name}"`;
  });
  const copies = z.coerce
    .number()
    .int()
    .min(1)
    .max(599)
    .default(599)
    .parse(context.url.searchParams.get('copies') ?? undefined);
  const ids = Array.from(
    { length: copies },
    (_, index) => `01${String(index + 1).padStart(24, '0')}`,
  );
  const selected = names.map((name) => {
    if (
      name === '"id"' ||
      name === '"live_revision_id"' ||
      name === '"translation_group"'
    )
      return 'fixture.value';
    if (name === '"slug"') return "'synthetic-library-' || fixture.value";
    return `source.${name}`;
  });
  const count = () =>
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ec_media_items AS item
       JOIN revisions AS revision ON revision.id = item.live_revision_id
         AND revision.entry_id = item.id
       JOIN ec_media_items AS source ON source.id = ? AND item.asset = source.asset
       WHERE item.id IN (SELECT value FROM json_each(?))
         AND item.status = 'published' AND item.deleted_at IS NULL
         AND item.draft_revision_id IS NULL`,
    )
      .bind(sourceId, JSON.stringify(ids))
      .first<number>('count');
  // Dev module invalidation may replay a request; validate the completed seed.
  if ((await count()) === ids.length) return Response.json({ ids });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO revisions (id, collection, entry_id, data, author_id, created_at)
       SELECT fixture.value, revision.collection, fixture.value,
              revision.data, revision.author_id, revision.created_at
       FROM ec_media_items AS source
       JOIN revisions AS revision ON revision.id = source.live_revision_id,
       json_each(?) AS fixture
       WHERE source.id = ? AND source.status = 'published'
         AND source.deleted_at IS NULL AND source.draft_revision_id IS NULL`,
    ).bind(JSON.stringify(ids), sourceId),
    env.DB.prepare(
      `INSERT INTO ec_media_items (${names.join(',')})
       SELECT ${selected.join(',')} FROM ec_media_items AS source, json_each(?) AS fixture
       WHERE source.id = ? AND source.status = 'published'
         AND source.deleted_at IS NULL AND source.draft_revision_id IS NULL`,
    ).bind(JSON.stringify(ids), sourceId),
  ]);
  if ((await count()) !== ids.length)
    throw new Error(
      'The native published source did not seed every requested photo',
    );
  return Response.json({ ids });
};
