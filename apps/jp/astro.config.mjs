import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import { d1, r2 } from '@emdash-cms/cloudflare';
import { cloudflareEmail } from '@emdash-cms/cloudflare/plugins';
import { defineConfig } from 'astro/config';
import emdash from 'emdash/astro';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { builtinModules, createRequire } from 'node:module';

// Use Astro's own Vite/Rolldown version for the native build plugin.
const astroRequire = createRequire(import.meta.resolve('astro'));
const { esmExternalRequirePlugin } = astroRequire('vite');
const workerBuiltins = esmExternalRequirePlugin({
  external: builtinModules.flatMap((name) => [name, `node:${name}`]),
});
workerBuiltins.apply = 'build';
workerBuiltins.applyToEnvironment = (environment) =>
  environment.config.consumer === 'server';

export default defineConfig({
  site: 'https://jp.bent.build',
  output: 'server',
  vite: {
    plugins: [workerBuiltins, tailwindcss()],
    // Keep the inline editor's view constructors shared and discover its HTML
    // block before first use, so cold edit-mode visits do not trigger a reload.
    optimizeDeps: {
      include: ['@tiptap/pm/view', '@emdash-cms/admin/html-block'],
    },
  },
  adapter: cloudflare({
    imageService: 'passthrough',
    persistState: process.env.TEST_EPHEMERAL === '1' ? false : undefined,
  }),
  integrations: [
    react(),
    {
      name: 'synthetic-integration-transport',
      hooks: {
        'astro:config:setup': ({ command, addMiddleware }) => {
          if (command === 'dev' && process.env.TEST_EPHEMERAL === '1')
            addMiddleware({
              order: 'pre',
              entrypoint: fileURLToPath(
                new URL('./scripts/integration-middleware.ts', import.meta.url),
              ),
            });
        },
      },
    },
    emdash({
      database: d1({ binding: 'DB', session: 'auto' }),
      storage: r2({ binding: 'MEDIA' }),
      toolbar: false,
      images: false,
      maxUploadSize: 64 * 1024 * 1024,
      plugins: [
        {
          id: 'japan-newsletter',
          version: '1.1.0',
          entrypoint: fileURLToPath(
            new URL('./src/plugins/newsletter.ts', import.meta.url),
          ),
          settingsSchema: {
            apiKey: { type: 'secret', label: 'Resend API key' },
            segmentId: { type: 'string', label: 'Newsletter segment' },
          },
        },
        cloudflareEmail({
          from: { email: 'login@auth.jp.bent.build', name: 'jp.bent.build' },
        }),
        {
          id: 'japan-trip',
          version: '1.0.0',
          entrypoint: fileURLToPath(
            new URL('./src/plugins/trip-policy.ts', import.meta.url),
          ),
          adminEntry: fileURLToPath(
            new URL('./src/plugins/admin.tsx', import.meta.url),
          ),
          fieldWidgets: [
            { name: 'gallery', label: 'Trip media', fieldTypes: ['json'] },
          ],
        },
      ],
    }),
  ],
  devToolbar: { enabled: false },
});
