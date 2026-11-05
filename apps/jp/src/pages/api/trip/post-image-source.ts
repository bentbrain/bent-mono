import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { savedImageInput, savedPostImage } from '../../../lib/saved-post-image';
import { savedImageRecovery } from '../../../lib/saved-image-recovery';

export const POST: APIRoute = async ({ request, locals, url }) => {
  if (!locals.user || locals.user.role < 50)
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  const input = savedImageInput.safeParse(
    await request.json().catch(() => null),
  );
  if (!input.success)
    return Response.json({ error: 'Saved image required' }, { status: 400 });
  return savedPostImage(
    input.data,
    url.origin,
    (id) => locals.emdash.handleContentGet('posts', id),
    undefined,
    (revisionId) => locals.emdash.handleRevisionGet(revisionId),
    {
      principalId: locals.user.id,
      verify: async (proof, binding) =>
        (await savedImageRecovery(env.EMDASH_ENCRYPTION_KEY)).verify(
          proof,
          binding,
        ),
    },
  );
};
