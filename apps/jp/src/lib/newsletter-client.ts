import { z } from 'zod';
import { api } from './api-client';
import { newsletterPath, newsletterStatusSchema } from './newsletter-model';

export async function newsletterOwnerRequest(body?: unknown) {
  const result = z
    .object({ success: z.literal(true), data: newsletterStatusSchema })
    .parse(
      await api(
        `${newsletterPath}/${body === undefined ? 'owner' : 'manage'}`,
        body,
      ),
    );
  return result.data;
}
export async function newsletterPublicRequest(
  action: 'subscribe' | 'confirm',
  body: unknown,
) {
  const result = z
    .object({
      success: z.literal(true),
      data: z.object({ ok: z.boolean(), message: z.string().optional() }),
    })
    .parse(await api(`${newsletterPath}/${action}`, body));
  if (!result.data.ok)
    throw new Error(result.data.message ?? 'please try again.');
}
