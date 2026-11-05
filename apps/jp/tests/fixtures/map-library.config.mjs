import base from '../../astro.config.mjs';
import { fileURLToPath } from 'node:url';

// Only the isolated library browser fixture loads this config. Production and
// the shared browser server keep the application's ordinary configuration.
export default {
  ...base,
  integrations: [
    ...base.integrations,
    {
      name: 'synthetic-map-library',
      hooks: {
        'astro:config:setup': ({ command, injectRoute }) => {
          if (command !== 'dev' || process.env.TEST_EPHEMERAL !== '1')
            throw new Error(
              'Map library fixture requires ephemeral development',
            );
          injectRoute({
            pattern: '/__synthetic/map-library',
            entrypoint: fileURLToPath(
              new URL('./map-library-endpoint.ts', import.meta.url),
            ),
          });
        },
      },
    },
  ],
};
