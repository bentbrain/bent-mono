import { env } from 'cloudflare:workers';
import { createNewsletterAssets } from './newsletter-assets';
import { optimiseNewsletterImage } from './newsletter-image';
import type { NewsletterContext } from './newsletter';
import { newsletterUrl } from './newsletter-model';

export function newsletterContext(
  ctx: NewsletterContext,
  origin = newsletterUrl,
): NewsletterContext {
  return {
    storage: ctx.storage,
    kv: ctx.kv,
    settings: ctx.settings,
    content: ctx.content,
    media: ctx.media,
    http: ctx.http,
    cron: ctx.cron,
    log: ctx.log,
    assets: createNewsletterAssets(
      ctx,
      env.MEDIA,
      (bytes) => optimiseNewsletterImage(env.IMAGES, bytes),
      origin,
    ),
  };
}
