import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const evidence = process.env.IMAGE_EVIDENCE_DIR;
const run = crypto.randomUUID();
const fixtureIds: string[] = [];
let fixturePostId = '';
const result = z.object({
  data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
});

test('public photo call sites deliver bounded responsive images without losing photos', async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  expect(
    (
      await request.post('/_emdash/api/setup/dev-bypass', { headers, data: {} })
    ).ok(),
  ).toBe(true);
  await request.get('/_emdash/api/auth/dev-bypass');
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  const ids = fixtureIds;
  const assetIds: string[] = [];
  const sourceBytes: number[] = [];
  for (const [width, height] of [
    [1200, 1600],
    [1600, 1200],
  ]) {
    if (!width || !height) throw new Error('Fixture dimensions required');
    const jpeg = await page.evaluate(
      ({ width, height }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas required');
        const pixels = context.createImageData(width, height);
        let seed = 12345;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const noise = (seed >>> 24) / 8;
            const index = (y * width + x) * 4;
            pixels.data[index] =
              (x / width) * 180 + noise + (y % 80 < 3 ? 45 : 0);
            pixels.data[index + 1] = (y / height) * 190 + noise;
            pixels.data[index + 2] = 80 + noise + (x % 100 < 3 ? 70 : 0);
            pixels.data[index + 3] = 255;
          }
        context.putImageData(pixels, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.9).split(',')[1] || '';
      },
      { width, height },
    );
    const buffer = Buffer.from(jpeg, 'base64');
    sourceBytes.push(buffer.length);
    const file = {
      name: 'synthetic-responsive.jpg',
      mimeType: 'image/jpeg',
      buffer,
    };
    const uploaded = await request.post('/api/trip/upload', {
      headers,
      multipart: { original: file, display: file, poster: file },
    });
    expect(uploaded.status()).toBe(201);
    const id = z
      .object({ data: z.object({ item: z.object({ id: z.string() }) }) })
      .parse(await uploaded.json()).data.item.id;
    const currentResponse: unknown = await (
      await request.get(`/_emdash/api/content/media_items/${id}`)
    ).json();
    const current = result.parse(currentResponse).data;
    assetIds.push(
      z
        .object({
          data: z.object({
            item: z.object({
              data: z.object({ asset: z.object({ id: z.string() }) }),
            }),
          }),
        })
        .parse(currentResponse).data.item.data.asset.id,
    );
    const saved = await request.put(`/_emdash/api/content/media_items/${id}`, {
      headers,
      data: {
        _rev: current._rev,
        data: {
          title: `Synthetic ${width > height ? 'landscape' : 'portrait'}`,
          captured_at: '2099-10-15T00:00:00Z',
          latitude: 27.1,
          longitude: 128.4,
          place: 'synthetic image fixture',
          categories: [],
          demo: true,
        },
      },
    });
    expect(saved.ok()).toBe(true);
    const revision = result.parse(
      await (
        await request.get(`/_emdash/api/content/media_items/${id}`)
      ).json(),
    ).data._rev;
    expect(
      (
        await request.post(`/_emdash/api/content/media_items/${id}/publish`, {
          headers,
          data: { _rev: revision },
        })
      ).ok(),
    ).toBe(true);
    ids.push(id);
  }
  const postSlug = `synthetic-images-${run}`;
  const post = await request.post('/_emdash/api/content/posts', {
    headers,
    data: {
      slug: postSlug,
      data: {
        title: 'Synthetic responsive images',
        day: '2099-10-15',
        content: [
          {
            _type: 'image',
            _key: 'synthetic-inline',
            asset: { _ref: assetIds[0] },
            alt: 'Synthetic inline photo',
          },
        ],
        gallery: ids,
        demo: true,
      },
    },
  });
  const current = result.parse(await post.json()).data;
  fixturePostId = current.item.id;
  expect(
    (
      await request.post(
        `/_emdash/api/content/posts/${current.item.id}/publish`,
        { headers, data: { _rev: current._rev } },
      )
    ).ok(),
  ).toBe(true);
  const deliveries = new Map<
    string,
    Promise<{
      bytes: number;
      encoded: string;
      format: string;
      noStore: string | undefined;
      cdn: string | undefined;
    }>
  >();
  let originalRequests = 0;
  let derivativeRequests = 0;
  page.on('response', (response) => {
    if (
      !response.url().includes('/media-preview/') &&
      !response.url().includes('/_emdash/api/media/')
    )
      return;
    if (response.url().includes('/media-preview/')) derivativeRequests++;
    else originalRequests++;
    deliveries.set(
      response.url(),
      (async () => ({
        bytes: (await response.body()).length,
        encoded: (await response.body()).toString('base64'),
        format: response.headers()['content-type'] || '',
        noStore: response.headers()['cache-control'],
        cdn: response.headers()['cdn-cache-control'],
      }))().catch(() => ({
        bytes: 0,
        encoded: '',
        format: '',
        noStore: undefined,
        cdn: undefined,
      })),
    );
  });
  // Model an image-only 1 Mbps connection with 80 ms latency. Keep scripts and
  // application startup unthrottled so the two image pipelines are comparable.
  const slowImages =
    /\/(?:media-preview|_emdash\/api\/media\/(?:file|asset))\//;
  await page.route(slowImages, async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    await new Promise((resolve) =>
      setTimeout(resolve, 80 + (body.length * 8) / 1000),
    );
    await route.fulfill({ response, body });
  });
  const measurements: unknown[] = [];
  const failures: string[] = [];
  for (const width of [390, 1280])
    for (const colorScheme of ['light', 'dark']) {
      if (colorScheme !== 'light' && colorScheme !== 'dark')
        throw new Error('Theme required');
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const path of ['/gallery', '/', `/posts/${postSlug}`]) {
        await page.goto(path);
        await expect(
          page.locator('astro-island[component-export="PostMedia"][ssr]'),
        ).toHaveCount(0);
        const images = page.locator(
          ids.map((id) => `[data-feedback-id="media-${id}"] img`).join(', '),
        );
        await expect(images).toHaveCount(2);
        const selectedImages = await images.evaluateAll(async (images) =>
          Promise.all(
            images.map(async (image) => {
              if (!(image instanceof HTMLImageElement))
                throw new Error('Image required');
              image.loading = 'eager';
              await image.decode();
              const resource = performance
                .getEntriesByName(image.currentSrc)
                .find((entry) => entry instanceof PerformanceResourceTiming);
              return {
                requestMs: resource?.duration,
                currentSrc: image.currentSrc,
                srcset: image.srcset,
                sizes: image.sizes,
                width: image.naturalWidth,
                height: image.naturalHeight,
                paintedWidth: image.clientWidth,
                paintedHeight: image.clientHeight,
              };
            }),
          ),
        );
        const selected = await Promise.all(
          selectedImages.map(async (image) => {
            const delivered = await deliveries.get(image.currentSrc);
            if (!delivered) throw new Error('Actual image response missing');
            const dimensions = await page.evaluate(
              async ({ encoded, format }) => {
                const blob = await (
                  await fetch(`data:${format};base64,${encoded}`)
                ).blob();
                const bitmap = await createImageBitmap(blob);
                return { width: bitmap.width, height: bitmap.height };
              },
              delivered,
            );
            return {
              requestMs: image.requestMs,
              srcset: image.srcset,
              sizes: image.sizes,
              ...dimensions,
              paintedWidth: image.paintedWidth,
              paintedHeight: image.paintedHeight,
              bytes: delivered.bytes,
              format: delivered.format,
              noStore: delivered.noStore,
              cdn: delivered.cdn,
              modeledTransferMsAt1Mbps: (delivered.bytes * 8) / 1000,
            };
          }),
        );
        measurements.push({
          viewport: width,
          colorScheme,
          route:
            path === '/gallery' ? 'gallery' : path === '/' ? 'home' : 'post',
          simulatedImageLink:
            width === 390 && colorScheme === 'light' && path === '/gallery'
              ? { megabitsPerSecond: 1, latencyMs: 80 }
              : undefined,
          selected,
        });
        if (path !== '/gallery') {
          const inline = page.getByRole('img', {
            name: 'Synthetic inline photo',
            exact: true,
          });
          await expect(inline).toHaveCount(1);
          await inline.evaluate(async (image) => {
            if (image instanceof HTMLImageElement) {
              image.loading = 'eager';
              await image.decode();
            }
          });
          if (evidence)
            await inline.screenshot({
              caret: 'initial',
              path: `${evidence}/${String(width)}-${colorScheme}-${path === '/' ? 'home' : 'post'}-inline.png`,
            });
          if (!(await inline.getAttribute('srcset')))
            failures.push('inline photo missing responsive candidates');
        }
        if (path !== '/gallery' && evidence) {
          const carousel =
            path === '/'
              ? page.locator(
                  `[data-feedback-id="post-${current.item.id}"] .post-carousel`,
                )
              : page.locator('.single-post .post-mosaic');
          await carousel.screenshot({
            caret: 'initial',
            path: `${evidence}/${String(width)}-${colorScheme}-${path === '/' ? 'home' : 'post'}-media.png`,
          });
        }
        if (path === '/gallery' && evidence) {
          await mkdir(evidence, { recursive: true });
          await page.screenshot({
            caret: 'initial',
            path: `${evidence}/${String(width)}-${colorScheme}-gallery.png`,
          });
        }
        if (width === 390 && colorScheme === 'light' && path === '/gallery')
          await page.unroute(slowImages);
        for (const image of selected) {
          if (!image.srcset || !image.sizes)
            failures.push('missing responsive candidates');
          if (width === 1280 && path === '/' && image.bytes >= 100_000)
            failures.push('small card exceeds 100KB synthetic transfer budget');
          expect(image.width).toBeLessThanOrEqual(1600);
          expect(image.noStore).toContain('no-store');
          expect(image.cdn).toBe('no-store');
        }
      }
      await page.goto(`/media/${ids[0] || ''}`);
      const viewer = page.locator('.viewer > img');
      await viewer.evaluate(async (image) => {
        if (image instanceof HTMLImageElement) await image.decode();
      });
      if (!(await viewer.getAttribute('srcset')))
        failures.push('viewer missing responsive candidates');
      if (evidence)
        await page.locator('.viewer').screenshot({
          caret: 'initial',
          path: `${evidence}/${String(width)}-${colorScheme}-viewer.png`,
        });
      await page.goto(`/?media=${ids[0] || ''}#japan-map`);
      const preview = page.locator('[data-feedback-id="map-preview"]');
      await expect(preview).toBeVisible();
      const mapPhotos = preview.locator('img');
      await expect(mapPhotos).toHaveCount(ids.length);
      for (const mapPhoto of await mapPhotos.all()) {
        await mapPhoto.evaluate(async (image) => {
          if (image instanceof HTMLImageElement) await image.decode();
        });
        if (
          !(await mapPhoto.getAttribute('srcset')) ||
          !(await mapPhoto.getAttribute('sizes'))
        )
          failures.push('map missing responsive candidates');
      }
      if (evidence)
        await preview.screenshot({
          caret: 'initial',
          path: `${evidence}/${String(width)}-${colorScheme}-map.png`,
        });
    }
  // Exercise middleware, native publication transitions and direct derivatives
  // through both owner and anonymous HTTP contexts, after a successful load.
  await page.goto('/gallery');
  const first = page.locator(`[data-feedback-id="media-${ids[0] || ''}"] img`);
  const derivative = await first.evaluate((image) =>
    image instanceof HTMLImageElement
      ? image.srcset.split(',')[0]?.trim().split(' ')[0] || ''
      : '',
  );
  if (derivative) {
    const largestPath = (await first.getAttribute('srcset'))
      ?.split(',')
      .at(-1)
      ?.trim()
      .split(' ')[0];
    if (!largestPath) throw new Error('Largest derivative required');
    const largest = await page.request.get(largestPath, {
      headers: { Accept: 'image/webp' },
    });
    expect(largest.status()).toBe(200);
    const encoded = (await largest.body()).toString('base64');
    const dimensions = await page.evaluate(async (encoded) => {
      const blob = await (
        await fetch(`data:image/webp;base64,${encoded}`)
      ).blob();
      const bitmap = await createImageBitmap(blob);
      return { width: bitmap.width, height: bitmap.height };
    }, encoded);
    expect(dimensions).toEqual({ width: 1200, height: 1600 });
    for (const suffix of ['?_preview=private', '?width=9999', '/extra']) {
      const denied = await page.request.get(`${derivative}${suffix}`);
      expect(denied.status()).toBe(404);
      expect(denied.headers()['cache-control']).toContain('no-store');
    }
    const malformed = await page.request.get('/media-preview/%25ZZ');
    expect(malformed.status()).toBe(404);
    expect(malformed.headers()['cdn-cache-control']).toBe('no-store');
    expect(
      (
        await page.request.get('/_image?href=trip-private/originals/synthetic')
      ).status(),
    ).toBe(404);
    const unpublished = await request.post(
      `/_emdash/api/content/media_items/${ids[0] || ''}/unpublish`,
      { headers, data: {} },
    );
    expect(unpublished.ok()).toBe(true);
    for (const client of [page.request, request]) {
      const denied = await client.get(derivative);
      expect(denied.status()).toBe(404);
      expect(denied.headers()['cloudflare-cdn-cache-control']).toBe('no-store');
    }
  }
  if (evidence)
    await writeFile(
      `${evidence}/measurements.json`,
      JSON.stringify(
        {
          synthetic: true,
          sourceBytes,
          originalRequests,
          derivativeRequests,
          measurements,
          failures,
        },
        null,
        2,
      ),
    );
  expect(failures).toEqual([]);
});

test.afterAll(async ({ request, baseURL }) => {
  await request.get('/_emdash/api/auth/dev-bypass');
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  if (fixturePostId)
    expect(
      (
        await request.delete(`/_emdash/api/content/posts/${fixturePostId}`, {
          headers,
        })
      ).ok(),
    ).toBe(true);
  for (const id of fixtureIds)
    expect(
      (
        await request.delete(`/_emdash/api/content/media_items/${id}`, {
          headers,
        })
      ).ok(),
    ).toBe(true);
});
