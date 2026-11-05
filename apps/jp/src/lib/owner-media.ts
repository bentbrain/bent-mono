import { z } from 'zod';

type CMS = {
  [Method in 'handleContentList' | 'handleContentGet']: (
    ...args: Parameters<App.Locals['emdash'][Method]>
  ) => Promise<{ success: boolean; data?: unknown }>;
};
const itemSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  version: z.number().int(),
  updatedAt: z.string(),
  draftRevisionId: z.string().nullish(),
  data: z.record(z.string(), z.unknown()),
});

// Lists contain current rows. Single-item reads are needed only for staged
// revisions, where EmDash overlays private draft data on live data.
export async function ownerMediaItems(cms: CMS) {
  const items: (z.infer<typeof itemSchema> & { _rev: string })[] = [];
  let cursor: string | undefined;
  do {
    const result = await cms.handleContentList('media_items', {
      limit: 100,
      orderBy: 'createdAt',
      order: 'desc',
      cursor,
    });
    if (!result.success) throw new Error('Could not load media');
    const page = z
      .object({
        items: z.array(itemSchema),
        nextCursor: z.string().nullish(),
      })
      .parse(result.data);
    for (const item of page.items) {
      if (item.draftRevisionId) {
        const current = await cms.handleContentGet('media_items', item.id);
        if (!current.success) throw new Error('Could not load media');
        const entry = z
          .object({ item: itemSchema, _rev: z.string() })
          .parse(current.data);
        items.push({ ...entry.item, _rev: entry._rev });
      } else {
        // EmDash 1.x encodes version:updatedAt as base64. Native-runtime tests
        // verify these tokens against handleContentGet and actual writes.
        items.push({
          ...item,
          _rev: btoa(`${String(item.version)}:${item.updatedAt}`),
        });
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export async function ownerMedia(cms: CMS & Pick<App.Locals['emdash'], 'db'>) {
  const items = await ownerMediaItems(cms);
  const ids = new Set<string>();
  for (const item of items) {
    for (const field of ['asset', 'poster']) {
      const reference = z
        .object({ id: z.string() })
        .safeParse(item.data[field]);
      if (reference.success) ids.add(reference.data.id);
    }
  }
  const media = new Map<string, { filename: string; storage_key: string }>();
  const unique = [...ids];
  // Stay below D1's parameter limit for libraries larger than one page.
  for (let offset = 0; offset < unique.length; offset += 90) {
    const rows = await cms.db
      .selectFrom('media')
      .select(['id', 'filename', 'storage_key'])
      .where('id', 'in', unique.slice(offset, offset + 90))
      .execute();
    for (const row of rows) media.set(row.id, row);
  }
  for (const item of items) {
    for (const field of ['asset', 'poster']) {
      const reference = z
        .object({ id: z.string() })
        .safeParse(item.data[field]);
      if (!reference.success) continue;
      const stored = media.get(reference.data.id);
      if (!stored) continue;
      const url = `/_emdash/api/media/asset/${encodeURIComponent(reference.data.id)}/${encodeURIComponent(stored.filename)}`;
      item.data[field] = { ...reference.data, url, src: url };
      item.data[field === 'asset' ? 'source_url' : 'poster_url'] =
        `/_emdash/api/media/file/${stored.storage_key}`;
    }
  }
  return { items };
}
