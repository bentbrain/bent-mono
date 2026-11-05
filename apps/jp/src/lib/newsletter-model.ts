import { z } from 'zod';
import { daySchema } from './model';
import { shopDesignSchema } from './shop-design';

export const newsletterFrom = 'jp.bent.build <hi@jp.bent.build>';
export const newsletterUrl = 'https://jp.bent.build';
export const newsletterPath = '/_emdash/api/plugins/japan-newsletter';
export const newsletterSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  frequency: z.enum(['weekly', 'interval']).default('weekly'),
  weekday: z.number().int().min(0).max(6).default(0),
  hour: z.number().int().min(0).max(23).default(18),
  days: z.number().int().min(1).max(30).default(3),
});
export type NewsletterSettings = z.infer<typeof newsletterSettingsSchema>;
const newsletterImageSchema = z.object({
  src: z.union([
    z.url({ protocol: /^https$/ }),
    z.url({ protocol: /^http$/, hostname: /^(localhost|127\.0\.0\.1)$/ }),
    z.string().regex(/^cid:[a-zA-Z0-9._-]+$/),
  ]),
  alt: z.string().max(300),
  width: z.number().int().min(1).max(1120),
  height: z.number().int().min(1).max(3360),
});
const digestPostSchema = z.object({
  id: z.string(),
  title: z.string(),
  day: daySchema,
  url: z.url(),
  excerpt: z.string(),
  images: z.array(newsletterImageSchema).optional(),
  shopDesign: shopDesignSchema
    .extend({ image: newsletterImageSchema })
    .optional(),
});
export type DigestPost = z.infer<typeof digestPostSchema>;
export const newsletterStatusSchema = z.object({
  settings: newsletterSettingsSchema,
  configured: z.boolean(),
  confirmed: z.number(),
  posts: z.array(digestPostSchema),
  nextSend: z.string(),
  lastRun: z
    .object({
      id: z.string(),
      status: z.string(),
      createdAt: z.number(),
      postCount: z.number(),
    })
    .nullable(),
});
export type NewsletterStatus = z.infer<typeof newsletterStatusSchema>;

export function nextNewsletterSend(
  settings: NewsletterSettings,
  now: number,
  lastAttempt?: number,
): number {
  const japan = new Date(now + 9 * 3600_000);
  const day = Date.UTC(
    japan.getUTCFullYear(),
    japan.getUTCMonth(),
    japan.getUTCDate(),
  );
  const hour = settings.hour * 3600_000 - 9 * 3600_000;
  if (settings.frequency === 'weekly') {
    let next =
      day +
      ((settings.weekday - japan.getUTCDay() + 7) % 7) * 86_400_000 +
      hour;
    if (next <= (lastAttempt ?? now)) next += 7 * 86_400_000;
    return next;
  }
  if (lastAttempt !== undefined) {
    const previous = new Date(lastAttempt + 9 * 3600_000);
    return (
      Date.UTC(
        previous.getUTCFullYear(),
        previous.getUTCMonth(),
        previous.getUTCDate() + settings.days,
      ) + hour
    );
  }
  const today = day + hour;
  return today > now ? today : today + 86_400_000;
}

export function newsletterExcerpt(value: unknown): string {
  const blocks = z
    .array(
      z
        .object({
          _type: z.string(),
          children: z
            .array(z.object({ _type: z.string(), text: z.string().optional() }))
            .optional(),
        })
        .loose(),
    )
    .safeParse(value);
  if (!blocks.success) return '';
  const text = blocks.data
    .filter((block) => block._type === 'block')
    .map((block) =>
      (block.children ?? [])
        .filter((child) => child._type === 'span')
        .map((child) => child.text ?? '')
        .join(''),
    )
    .join('\n\n')
    .trim();
  return text;
}

export async function newsletterHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
