import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

// Real GSI public geometry around Tokyo station, never owner's GPS or media.
// Source: https://github.com/gsi-cyberjapan/optimal_bvmap
// Retrieved 2026-10-28, custom styling under the GSI content usage terms.
export async function routeMapContext(page: Page) {
  // English annotations: https://www.gsi.go.jp/kihonjohochousa/multilingual
  // Retrieved 2026-10-28 under GSI content usage terms. These fixtures
  // contain only public names and coordinates around Tokyo station.
  await page.route(
    'https://maps.gsi.go.jp/xyz/experimental_multil/**',
    async (route) => {
      const match = /\/(\d+)\/(\d+)\/(\d+)\.geojson$/.exec(
        route.request().url(),
      );
      if (!match) throw new Error('Unexpected annotation source');
      let body: Buffer;
      try {
        body = await readFile(
          new URL(
            `./map-places/${match.slice(1).join('-')}.geojson`,
            import.meta.url,
          ),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
        body = Buffer.alloc(0);
      }
      await route.fulfill({
        status: body.length ? 200 : 404,
        contentType: 'application/geo+json',
        body,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    },
  );
  await page.route('https://cyberjapandata.gsi.go.jp/**', async (route) => {
    const match = /\/optimal_bvmap-v1\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(
      route.request().url(),
    );
    if (!match) throw new Error('Unexpected raster or other map source');
    const z = Number(match[1]);
    const x = Math.floor(((139.767125 + 180) / 360) * 2 ** z);
    const y = Math.floor(
      ((1 - Math.asinh(Math.tan((35.681236 * Math.PI) / 180)) / Math.PI) / 2) *
        2 ** z,
    );
    const body =
      Number(match[2]) === x && Number(match[3]) === y
        ? await readFile(
            new URL(
              `./map-context/${String(z)}-${String(x)}-${String(y)}.pbf`,
              import.meta.url,
            ),
          )
        : Buffer.alloc(0);
    await route.fulfill({
      status: body.length ? 200 : 404,
      contentType: 'application/x-protobuf',
      body,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
}
