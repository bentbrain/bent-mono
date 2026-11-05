import { z } from 'zod';
import { mediaEditData, mediaEditSchema } from './media-edits';

// The native runtime and Astro facade expose different content response types.
// Validate the shared handler envelope below before consuming its data.
type CMS = {
  [
    Method in
      | 'handleContentGet'
      | 'handleContentUpdate'
      | 'handleContentPublish'
      | 'handleRevisionGet'
  ]: (
    ...args: Parameters<App.Locals['emdash'][Method]>
  ) => Promise<{ success: boolean; data?: unknown; error?: unknown }>;
};

function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value: unknown, index) => sameData(value, right[index]))
    );
  const a = z.record(z.string(), z.unknown()).safeParse(left);
  const b = z.record(z.string(), z.unknown()).safeParse(right);
  return (
    a.success &&
    b.success &&
    Object.keys(a.data).length === Object.keys(b.data).length &&
    Object.entries(a.data).every(
      ([key, value]) =>
        Object.hasOwn(b.data, key) && sameData(value, b.data[key]),
    )
  );
}

export async function saveMediaEdit(
  cms: CMS,
  actor: { id: string; role: number },
  input: z.infer<typeof mediaEditSchema>,
) {
  const { id, revision, changes } = input;
  const current = await cms.handleContentGet('media_items', id);
  if (!current.success || !current.data)
    return Response.json(current, { status: 404 });
  const entry = z
    .object({
      _rev: z.string(),
      item: z.object({
        status: z.string(),
        version: z.number().int(),
        draftRevisionId: z.string().nullish(),
        data: z.record(z.string(), z.unknown()),
        liveData: z.record(z.string(), z.unknown()).optional(),
      }),
    })
    .parse(current.data);
  if (entry._rev !== revision)
    return Response.json(
      { error: 'Photo changed. Review it before retrying.' },
      { status: 409 },
    );
  if (!['draft', 'published'].includes(entry.item.status))
    return Response.json(
      { error: 'Only drafts and published photos can be edited' },
      { status: 422 },
    );
  let data: Record<string, unknown>;
  try {
    data = mediaEditData(
      entry.item.status === 'published'
        ? (entry.item.liveData ?? entry.item.data)
        : entry.item.data,
      changes,
    );
  } catch {
    return Response.json(
      { error: 'A photo can have at most 20 valid categories' },
      { status: 400 },
    );
  }
  async function publish(revision: string) {
    const result = await cms.handleContentPublish('media_items', id, {
      _rev: revision,
      actor,
      origin: { source: 'api' },
    });
    return Response.json(result, { status: result.success ? 200 : 422 });
  }
  if (entry.item.status === 'published' && entry.item.draftRevisionId) {
    // A failed publish can resume only when the ENTIRE pending draft is exactly
    // this requested patch over live data. Never promote unrelated private edits.
    const pending = await cms.handleRevisionGet(entry.item.draftRevisionId);
    const raw = z
      .object({
        item: z.object({ data: z.record(z.string(), z.unknown()) }),
      })
      .safeParse(pending.data);
    if (
      !entry.item.liveData ||
      !pending.success ||
      !raw.success ||
      !sameData(raw.data.item.data, { ...entry.item.liveData, ...data })
    )
      return Response.json(
        {
          error:
            'Photo has unpublished edits. Save it individually before bulk editing.',
        },
        { status: 409 },
      );
    return publish(revision);
  }
  const saved = await cms.handleContentUpdate('media_items', id, {
    data,
    _rev: revision,
    actor,
  });
  if (!saved.success || !saved.data)
    return Response.json(saved, { status: 409 });
  if (entry.item.status !== 'published') return Response.json(saved);
  const staged = z
    .object({ _rev: z.string(), item: z.object({ version: z.number().int() }) })
    .parse(saved.data);
  // Native data-only saves advance the version exactly once. Their response
  // rereads the row, so it may instead contain a later writer's revision.
  if (staged.item.version !== entry.item.version + 1)
    return Response.json(
      { error: 'Photo changed while saving. Review it before retrying.' },
      { status: 409 },
    );
  // The native publish precondition also fences changes after this response.
  return publish(staged._rev);
}
