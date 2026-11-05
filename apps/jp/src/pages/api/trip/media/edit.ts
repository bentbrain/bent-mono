import type { APIRoute } from 'astro';
import { mediaEditSchema } from '../../../../lib/media-edits';
import { saveMediaEdit } from '../../../../lib/save-media-edit';

export const PATCH: APIRoute = async ({ request, locals }) => {
  if (!locals.user)
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  const parsed = mediaEditSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return Response.json(
      { error: 'Choose valid fields to change' },
      { status: 400 },
    );
  return saveMediaEdit(
    locals.emdash,
    { id: locals.user.id, role: locals.user.role },
    parsed.data,
  );
};
