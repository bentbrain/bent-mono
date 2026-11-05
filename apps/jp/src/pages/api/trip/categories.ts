import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { normalizeCategory } from '../../../lib/category-icons';
import {
  categoryCollection,
  registerCategory,
} from '../../../lib/category-collections';

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user)
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  return Response.json(
    await categoryCollection(env, locals.emdash, locals.user),
  );
};
export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user)
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  const body = z
    .object({ name: z.string().min(1).max(40) })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!body.success)
    return Response.json(
      { error: 'Choose a category of 1 to 40 characters' },
      { status: 400 },
    );
  if (!normalizeCategory(body.data.name))
    return Response.json(
      { error: 'Choose a category of 1 to 40 characters' },
      { status: 400 },
    );
  const category = await registerCategory(env, body.data.name);
  return Response.json({
    ...(await categoryCollection(env, locals.emdash, locals.user)),
    category,
  });
};
