import { definePlugin } from 'emdash';
import { env } from 'cloudflare:workers';
import { pluginResponse } from 'emdash/plugin';
import { newsletterContext } from '../lib/newsletter-runtime';
import {
  configureNewsletter,
  confirmSubscription,
  newsletterStatus,
  requestSubscription,
  newsletterCron,
  pendingDigestPosts,
} from '../lib/newsletter';
import { digestEmail } from '../emails/newsletter';
import { newsletterUrl } from '../lib/newsletter-model';

export function createPlugin() {
  return definePlugin({
    id: 'japan-newsletter',
    version: '1.1.0',
    capabilities: [
      'content:read',
      'media:read',
      'media:bytes:read',
      'network:request',
    ],
    allowedHosts: ['api.resend.com', 'shop.bent.build'],
    storage: {
      subscribers: { indexes: ['confirmed', 'requestedAt'] },
      confirmations: { indexes: ['expiresAt'] },
      limits: { indexes: ['expiresAt'] },
      sent: { indexes: [] },
      runs: { indexes: [] },
    },
    admin: {
      settingsSchema: {
        apiKey: { type: 'secret', label: 'Resend API key' },
        segmentId: { type: 'string', label: 'Newsletter segment' },
      },
    },
    hooks: {
      'plugin:activate': async (_event, ctx) => {
        await ctx.cron?.schedule('digest', { schedule: '*/5 * * * *' });
      },
      cron: newsletterCron(() => env.OWNER_EMAIL, newsletterContext),
    },
    routes: {
      image: {
        public: true,
        methods: ['GET'],
        request: { body: 'none' },
        response: 'raw',
        handler: async (ctx) => {
          const query = new URL(ctx.request.url).searchParams;
          try {
            const bytes = await newsletterContext(ctx).assets?.read(
              query.get('post') || '',
              query.get('key') || '',
            );
            if (bytes)
              return pluginResponse({
                headers: { 'Content-Type': 'image/jpeg' },
                body: { kind: 'bytes', value: bytes },
              });
          } catch {}
          return pluginResponse({ status: 404 });
        },
      },
      preview: {
        methods: ['GET'],
        handler: async (ctx) => {
          if (
            !ctx.user ||
            ctx.user.role < 50 ||
            (!import.meta.env.DEV && ctx.user.email !== env.OWNER_EMAIL)
          )
            throw new Error('Owner account required');
          return digestEmail(
            await pendingDigestPosts(
              newsletterContext(
                ctx,
                import.meta.env.DEV
                  ? new URL(ctx.request.url).origin
                  : newsletterUrl,
              ),
            ),
            newsletterUrl,
            true,
          );
        },
      },
      subscribe: {
        public: true,
        methods: ['POST'],
        request: { body: 'json', maxBytes: 1024 },
        handler: async (ctx) => {
          const origin = new URL(ctx.request.url).origin;
          if (ctx.request.headers.get('origin') !== origin)
            return { ok: false, message: 'request rejected.' };
          return requestSubscription(
            ctx,
            ctx.input,
            ctx.requestMeta.ip ?? 'unknown',
            import.meta.env.DEV ? origin : newsletterUrl,
            env.OWNER_EMAIL,
          );
        },
      },
      confirm: {
        public: true,
        methods: ['POST'],
        request: { body: 'json', maxBytes: 1024 },
        handler: async (ctx) => {
          if (
            ctx.request.headers.get('origin') !==
            new URL(ctx.request.url).origin
          )
            return { ok: false, message: 'request rejected.' };
          return confirmSubscription(ctx, ctx.input);
        },
      },
      owner: {
        methods: ['GET'],
        request: { body: 'none' },
        handler: async (ctx) => {
          if (
            !ctx.user ||
            ctx.user.role < 50 ||
            (!import.meta.env.DEV && ctx.user.email !== env.OWNER_EMAIL)
          )
            throw new Error('Owner account required');
          return newsletterStatus(
            newsletterContext(
              ctx,
              import.meta.env.DEV
                ? new URL(ctx.request.url).origin
                : newsletterUrl,
            ),
          );
        },
      },
      manage: {
        methods: ['POST'],
        request: { body: 'json', maxBytes: 2048 },
        handler: async (ctx) => {
          if (
            !ctx.user ||
            ctx.user.role < 50 ||
            (!import.meta.env.DEV && ctx.user.email !== env.OWNER_EMAIL)
          )
            throw new Error('Owner account required');
          if (
            ctx.request.headers.get('origin') !==
            new URL(ctx.request.url).origin
          )
            throw new Error('Request rejected');
          return configureNewsletter(
            newsletterContext(
              ctx,
              import.meta.env.DEV
                ? new URL(ctx.request.url).origin
                : newsletterUrl,
            ),
            ctx.input,
            import.meta.env.DEV ? ctx.user.email : env.OWNER_EMAIL,
          );
        },
      },
    },
  });
}
