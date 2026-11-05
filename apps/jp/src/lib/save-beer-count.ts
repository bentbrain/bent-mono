import { z } from 'zod';
import { publishItem, savedItemSchema } from './publish';

// Validate responses at the native-runtime/Astro-facade boundary, as their
// handler envelopes expose different data and plugin rejection detail types.
type BeerCMS = {
  [
    Method in
      | 'handleContentGet'
      | 'handleContentGetIncludingTrashed'
      | 'handleContentList'
      | 'handleContentCreate'
      | 'handleContentUpdate'
      | 'handleContentPublish'
  ]: (...args: Parameters<App.Locals['emdash'][Method]>) => Promise<{
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string; details?: unknown };
  }>;
};

export async function saveBeerCount(
  emdash: BeerCMS,
  day: string,
  count: number,
  actor: { id: string; role: number },
) {
  // Saves use the day as the unique slug. Check it before the custom field,
  // which can differ on older records and miss the entry that owns the slug.
  let current = await emdash.handleContentGet('beers', day);
  if (!current.success) {
    if (current.error?.code !== 'NOT_FOUND')
      return Response.json(current, { status: 500 });
    const result = await emdash.handleContentList('beers', {
      fieldFilters: { day },
      limit: 2,
    });
    if (!result.success) return Response.json(result, { status: 500 });
    const listed = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(result.data);
    const existing = listed.items[0];
    if (existing) {
      current = await emdash.handleContentGet('beers', existing.id);
      if (!current.success || !current.data)
        return Response.json(current, { status: 500 });
    }
  }
  let saved;
  if (current.success && current.data) {
    const entry = savedItemSchema
      .extend({ _rev: z.string().optional() })
      .parse(current.data);
    const id = entry.item.id;
    saved = await emdash.handleContentUpdate('beers', id, {
      data: { title: day, day, count },
      _rev: entry._rev,
      actor,
    });
  } else {
    let suffix = 0;
    let slug = day;
    for (;;) {
      const reserved = await emdash.handleContentGetIncludingTrashed(
        'beers',
        slug,
      );
      if (!reserved.success) {
        if (reserved.error?.code !== 'NOT_FOUND')
          return Response.json(reserved, { status: 500 });
        break;
      }
      // Including-trashed reads do not expose deletedAt. Only advance when
      // the reserved entry is absent from the normal, active-only lookup.
      const active = await emdash.handleContentGet('beers', slug);
      if (active.success)
        return Response.json(
          { error: 'beer count changed. save again.' },
          { status: 409 },
        );
      if (active.error?.code !== 'NOT_FOUND')
        return Response.json(active, { status: 500 });
      suffix++;
      slug = `${day}-${String(suffix)}`;
    }
    saved = await emdash.handleContentCreate('beers', {
      // Concurrent first saves choose the same explicit slug. The native
      // unique constraint rejects the loser instead of creating another day.
      slug,
      data: { title: day, day, count },
      authorId: actor.id,
      actor,
    });
  }
  if (!saved.success) return Response.json(saved, { status: 409 });
  const id = savedItemSchema.parse(saved.data).item.id;
  const published = await publishItem(emdash, 'beers', id, actor);
  return Response.json(published, { status: published.success ? 200 : 400 });
}
