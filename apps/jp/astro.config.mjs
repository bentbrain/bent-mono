import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import { d1, r2 } from '@emdash-cms/cloudflare';
import { cloudflareEmail } from '@emdash-cms/cloudflare/plugins';
import { defineConfig } from 'astro/config';
import emdash from 'emdash/astro';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  site: 'https://jp.bent.build',
  output: 'server',
  vite: {
    plugins: [tailwindcss()],
    // EmDash's inline editor loads Focus/Placeholder outside the prebundled core.
    // Keep their DecorationSet/EditorView constructors in the same client graph.
    optimizeDeps: { include: ['@tiptap/pm/view'] },
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
