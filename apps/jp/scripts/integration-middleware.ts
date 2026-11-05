import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { drainDeniedRequest } from './integration-transport';

export const onRequest = defineMiddleware(async (context, next) => {
  // This middleware is registered only in TEST_EPHEMERAL development runtimes.
  // Never use a real deployment key for synthetic reference attestations.
  env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${'A'.repeat(43)}`;
  return drainDeniedRequest(context.request, await next());
});
