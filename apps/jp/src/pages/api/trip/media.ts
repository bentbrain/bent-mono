import { ownerMedia } from '../../../lib/owner-media';
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { metadataSchema } from '../../../lib/model';

export const GET: APIRoute = async ({ locals }) =>
  Response.json(await ownerMedia(locals.emdash));
export const PATCH: APIRoute = async ({ request, locals }) => {
  const parsed = z
    .object({
      id: z.string(),
      revision: z.string(),
      publish: z.boolean(),
      metadata: metadataSchema,
    })
    .safeParse(await request.json());
  if (!parsed.success || !locals.user)
    return Response.json(
      { error: 'Add a capture time and coordinates' },
      { status: 400 },
    );
  const { id, revision, publish, metadata } = parsed.data,
    actor = { id: locals.user.id, role: locals.user.role };
  const saved = await locals.emdash.handleContentUpdate('media_items', id, {
    data: { ...metadata, captured_at: metadata.captured_at.toISOString() },
    _rev: revision,
    actor,
  });
  if (!saved.success) return Response.json(saved, { status: 409 });
  const current = await locals.emdash.handleContentGet('media_items', id);
  if (!current.success || !current.data)
    return Response.json(current, { status: 500 });
  const result = publish
    ? await locals.emdash.handleContentPublish('media_items', id, {
        _rev: current.data._rev,
        actor,
        origin: { source: 'api' },
      })
    : current.data.item.status === 'published'
      ? await locals.emdash.handleContentUnpublish('media_items', id, {
          _rev: current.data._rev,
          actor,
          origin: { source: 'api' },
        })
      : current;
  return Response.json(result, { status: result.success ? 200 : 422 });
};
