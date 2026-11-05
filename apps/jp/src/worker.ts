import type { ExportedHandler } from '@cloudflare/workers-types';
import handler, {
  createScheduledHandler,
  PluginBridge,
} from '@emdash-cms/cloudflare/worker';

import { runCategoryIconJobs } from './lib/category-icon-jobs';
import { deferPublicVideoMetadata } from './lib/public-video-html';
import { isKnownProbe } from './lib/request-guard';

declare const Response: typeof import('@cloudflare/workers-types').Response;

export { PluginBridge };
const cmsScheduled = createScheduledHandler();
const cmsFetch = handler.fetch;
if (!cmsFetch) throw new Error('CMS fetch handler required');

export default {
  ...handler,
  async fetch(request, env, ctx) {
    if (isKnownProbe(new URL(request.url).pathname))
      return new Response(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    return deferPublicVideoMetadata(await cmsFetch(request, env, ctx));
  },
  async scheduled(controller, env, ctx) {
    await cmsScheduled(controller, env, ctx);
    ctx.waitUntil(runCategoryIconJobs(env));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
