import type { APIRoute } from 'astro';
import { z } from 'zod';
import { daySchema } from '../../../lib/model';
import { saveBeerCount } from '../../../lib/save-beer-count';

export const POST: APIRoute = async ({ request, locals }) => {
  const parsed = z
    .object({ day: daySchema, count: z.number().int().min(0).max(100) })
    .safeParse(await request.json());
  if (!parsed.success || !locals.user)
    return Response.json({ error: 'Choose a day and count' }, { status: 400 });
  const { day, count } = parsed.data;
  return saveBeerCount(locals.emdash, day, count, {
    id: locals.user.id,
    role: locals.user.role,
  });
};
