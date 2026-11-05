import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { join } from 'node:path';
import { startIsolatedBrowserServer } from '../fixtures/isolated-browser-server';
const fixtureIds: string[] = [];
const result = z.object({
  data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
});

function requestsForPhoto(srcset: string, source: string, requests: string[]) {
  return requests.filter(
    (url) =>
      url === source ||
      srcset.split(',').some((candidate) => {
        const path = candidate.trim().split(' ')[0];
        return path ? url.endsWith(path) : false;
      }),
  );
}

test.beforeAll(async ({ request, baseURL, browser }) => {
  const page = await browser.newPage();
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
    [1200, 1200],
  ]) {
    if (!width || !height) throw new Error('Fixture dimensions required');
    const jpeg =
      await test.step(`measure: map JPEG generation ${String(width)}x${String(height)}`, () =>
        page.evaluate(
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
        ));
    const buffer = Buffer.from(jpeg, 'base64');
    sourceBytes.push(buffer.length);
    const file = {
      name: 'synthetic-responsive.jpg',
      mimeType: 'image/jpeg',
      buffer,
    };
    const uploaded = await test.step('measure: map media upload', () =>
      request.post('/api/trip/upload', {
        headers,
        multipart: { original: file, display: file, poster: file },
      }));
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
          title: `Synthetic ${width > height ? 'landscape' : width === height ? 'square' : 'portrait'}`,
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

  await page.close();
});

for (const width of [390, 671, 672, 1280, 1991])
  for (const height of [390, 844, 1200])
    for (const dpr of [1, 2])
      for (const colorScheme of ['light', 'dark'] satisfies (
        'light' | 'dark'
      )[])
        test(`map fresh selection ${String(width)}x${String(height)} DPR${String(dpr)} ${colorScheme}`, async ({
          browser,
          baseURL,
        }) => {
          const evidence = process.env.MAP_IMAGE_EVIDENCE_DIR;
          if (evidence) await mkdir(evidence, { recursive: true });
          const measurements: unknown[] = [];
          const failures: unknown[] = [];

          const context = await browser.newContext({
            viewport: { width, height },
            colorScheme,
            deviceScaleFactor: dpr,
          });
          await context.route('https://toolbar.bent.build/embed.js', (route) =>
            route.fulfill({ contentType: 'application/javascript', body: '' }),
          );
          try {
            // Each shape owns a fresh page and an isolated measured-slot control.
            // Overlap these three read-only journeys without sharing image state.
            const outcomes = await Promise.allSettled(
              fixtureIds.map(async (id, index) => {
                const fresh = await context.newPage();
                const requests: string[] = [];
                fresh.on('request', (r) => {
                  if (
                    r.url().match(/\/(?:media-preview|_emdash\/api\/media)\//)
                  )
                    requests.push(r.url());
                });
                await fresh.goto(`${baseURL || ''}/?media=${id}#japan-map`);
                const image = fresh.locator(
                  '[data-feedback-id="map-preview"] [data-map-photo="active"] img',
                );
                await expect(image).toBeVisible();
                const measured = await image.evaluate(async (image, id) => {
                  if (!(image instanceof HTMLImageElement))
                    throw new Error('Photo required');
                  await image.decode();
                  const box = image.getBoundingClientRect();
                  return {
                    width: box.width,
                    height: box.height,
                    sizes: image.sizes,
                    bytes: performance
                      .getEntriesByName(image.currentSrc)
                      .find(
                        (entry) => entry instanceof PerformanceResourceTiming,
                      )?.encodedBodySize,
                    srcset: image.srcset,
                    source: image.src,
                    selected: image.currentSrc.match(/\/(\d+)\/auto$/)?.[1],
                    resolution: performance
                      .getEntriesByType('resource')
                      .filter((entry) =>
                        entry.name.includes(`/map-photo/${id}/`),
                      )
                      .map((entry) => ({
                        startMs: entry.startTime,
                        durationMs: entry.duration,
                      })),
                    imageStartMs: performance.getEntriesByName(
                      image.currentSrc,
                    )[0]?.startTime,
                    measuredAtMs: performance.now(),
                  };
                }, id);
                const controlContext = await browser.newContext({
                  deviceScaleFactor: dpr,
                });
                let control: string | undefined;
                try {
                  const controlPage = await controlContext.newPage();
                  await controlPage.goto(`${baseURL || ''}/_emdash/api/health`);
                  control = await controlPage.evaluate(
                    async ({ srcset, width }) => {
                      const image = new Image();
                      image.sizes = `${String(width)}px`;
                      image.srcset = srcset;
                      await image.decode();
                      return image.currentSrc.match(/\/(\d+)\/auto$/)?.[1];
                    },
                    measured,
                  );
                } finally {
                  await controlContext.close();
                }
                expect(measured.resolution).toHaveLength(1);
                const mapRequests = requestsForPhoto(
                  measured.srcset,
                  measured.source,
                  requests,
                );
                expect(mapRequests).toHaveLength(1);
                expect(
                  await fresh.evaluate(
                    () => matchMedia('(prefers-color-scheme: dark)').matches,
                  ),
                ).toBe(colorScheme === 'dark');
                measurements[index] = {
                  index,
                  dpr,
                  ...measured,
                  control,
                  requests: mapRequests,
                };
                if (
                  !measured.selected ||
                  !control ||
                  measured.selected !== control
                )
                  failures.push({ index, ...measured, control });
                if (evidence)
                  await fresh
                    .locator('[data-feedback-id="map-preview"]')
                    .screenshot({
                      path: `${evidence}/${String(width)}-${String(height)}-${String(dpr)}-${colorScheme}-shape${String(index)}.png`,
                    });
                await fresh.close();
              }),
            );
            for (const outcome of outcomes) {
              if (outcome.status === 'rejected') {
                if (outcome.reason instanceof Error) throw outcome.reason;
                throw new Error('Map photo journey failed');
              }
            }
          } finally {
            await context.close();
          }
          if (evidence)
            await writeFile(
              `${evidence}/${String(width)}-${String(height)}-${String(dpr)}-${colorScheme}.json`,
              JSON.stringify({ measurements, failures }, null, 2),
            );
          expect(failures).toEqual([]);
        });

test('gallery to viewer to map keeps the first request small, handles late fonts, resize and selection', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 844 },
    deviceScaleFactor: 2,
  });
  await context.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  const page = await context.newPage();
  await page.goto(`${baseURL || ''}/gallery`);
  await page
    .getByRole('link', { name: 'Synthetic portrait', exact: true })
    .click();
  await expect(page.locator('.viewer > img')).toBeVisible();
  const requests: string[] = [];
  let mapNavigation = false;
  page.on('request', (request) => {
    if (
      mapNavigation &&
      request.url().match(/\/(?:media-preview|_emdash\/api\/media)\//)
    )
      requests.push(request.url());
  });
  mapNavigation = true;
  await page.getByRole('link', { name: 'VIEW ON MAP', exact: true }).click();
  const popup = page.locator('[data-feedback-id="map-preview"]');
  const image = popup.locator('[data-map-photo="active"] img');
  await expect(image).toBeVisible();
  await image.evaluate(async (image) => {
    if (image instanceof HTMLImageElement) await image.decode();
  });
  const photo = await image.evaluate((image) => {
    if (!(image instanceof HTMLImageElement)) throw new Error('Photo required');
    return { srcset: image.srcset, source: image.src };
  });
  const mapRequests = requestsForPhoto(photo.srcset, photo.source, requests);
  expect(mapRequests).toHaveLength(1);
  expect(mapRequests[0]).toMatch(/\/800\/auto$/);
  const evidence = process.env.MAP_IMAGE_EVIDENCE_DIR;
  if (evidence)
    await popup.screenshot({ path: `${evidence}/gallery-viewer-map.png` });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1991, height: 1200 },
    { width: 1280, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        image.evaluate((image) => image.getBoundingClientRect().width),
      )
      .toBeCloseTo(
        Math.min(viewport.width - 58, 614, viewport.height * 0.55 * 0.75),
        0,
      );
  }
  for (let index = 0; index < 3; index++) {
    await popup
      .getByRole('button', { name: 'Next media at this location' })
      .click();
    await image.evaluate(async (image) => {
      if (image instanceof HTMLImageElement) await image.decode();
    });
    expect(await image.getAttribute('sizes')).toContain('dvh');
  }
  await popup
    .getByRole('button', { name: 'Previous media at this location' })
    .click();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('sizes', /dvh/);
  await popup.getByRole('button', { name: 'Close map preview' }).click();
  await expect(popup).toHaveCount(0);
  await context.close();

  const late = await browser.newContext({
    viewport: { width: 1280, height: 844 },
    deviceScaleFactor: 2,
  });
  await late.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  let release = () => {};
  const fonts = new Promise<void>((resolve) => {
    release = resolve;
  });
  await late.route('**/*.woff2', async (route) => {
    await fonts;
    await route.continue();
  });
  const fresh = await late.newPage();
  const lateRequests: string[] = [];
  fresh.on('request', (r) => {
    if (r.url().match(/\/(?:media-preview|_emdash\/api\/media)\//))
      lateRequests.push(r.url());
  });
  await fresh.goto(`${baseURL || ''}/?media=${fixtureIds[0] || ''}#japan-map`, {
    waitUntil: 'domcontentloaded',
  });
  const lateImage = fresh.locator(
    '[data-feedback-id="map-preview"] [data-map-photo="active"] img',
  );
  await expect(lateImage).toBeVisible();
  await lateImage.evaluate(async (image) => {
    if (image instanceof HTMLImageElement) await image.decode();
  });
  const latePhoto = await lateImage.evaluate((image) => {
    if (!(image instanceof HTMLImageElement)) throw new Error('Photo required');
    return { srcset: image.srcset, source: image.src };
  });
  expect(
    requestsForPhoto(latePhoto.srcset, latePhoto.source, lateRequests),
  ).toHaveLength(1);
  expect(
    requestsForPhoto(latePhoto.srcset, latePhoto.source, lateRequests)[0],
  ).toMatch(/\/800\/auto$/);
  release();
  await fresh.evaluate(() => document.fonts.ready);
  expect(
    requestsForPhoto(latePhoto.srcset, latePhoto.source, lateRequests),
  ).toHaveLength(1);
  await late.close();
});

test('only the active photo resolves before its first image, and closing cancels pending selection', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 844 },
    deviceScaleFactor: 2,
  });
  await context.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolutions: string[] = [];
  await context.route('**/map-photo/**', async (route) => {
    resolutions.push(route.request().url());
    await pending;
    await route.continue().catch(() => {});
  });
  const page = await context.newPage();
  await page.goto(`${baseURL || ''}/?media=${fixtureIds[0] || ''}#japan-map`);
  const popup = page.locator('[data-feedback-id="map-preview"]');
  await expect(popup).toBeVisible();
  try {
    await expect(popup.locator('[data-map-photo="active"] img')).toHaveCount(0);
    await expect.poll(() => resolutions.length).toBe(1);
    await expect(popup.getByRole('status')).toHaveText('loading photo');
    await popup
      .getByRole('button', { name: 'Next media at this location' })
      .click();
    await expect.poll(() => resolutions.length).toBe(2);
    await expect(popup.locator('[data-map-photo="active"] img')).toHaveCount(0);
    await popup.getByRole('button', { name: 'Close map preview' }).click();
    release();
    await expect(popup).toHaveCount(0);
    await expect(
      page.locator(
        '[data-feedback-id="map-preview"] [data-map-photo="active"] img',
      ),
    ).toHaveCount(0);
  } finally {
    release();
    await context.close();
  }
});

test('transient dimension failure keeps controls available and retries before any image download', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 844 },
    deviceScaleFactor: 2,
  });
  await context.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  let calls = 0;
  await context.route(
    `**/map-photo/${fixtureIds[0] || ''}/**`,
    async (route) => {
      calls++;
      if (calls === 1)
        await route.fulfill({
          status: 503,
          body: 'synthetic transient failure',
        });
      else await route.continue();
    },
  );
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/media-preview/')) requests.push(r.url());
  });
  await page.goto(`${baseURL || ''}/?media=${fixtureIds[0] || ''}#japan-map`);
  const popup = page.locator('[data-feedback-id="map-preview"]');
  await expect(
    popup.getByRole('button', { name: 'RETRY PHOTO' }),
  ).toBeVisible();
  await expect(popup.locator('[data-map-photo="active"] img')).toHaveCount(0);
  await expect(
    popup.getByRole('button', { name: 'Next media at this location' }),
  ).toBeEnabled();
  await popup.getByRole('button', { name: 'RETRY PHOTO' }).click();
  const image = popup.locator('[data-map-photo="active"] img');
  await expect(image).toBeVisible();
  const photo = await image.evaluate(async (image) => {
    if (!(image instanceof HTMLImageElement)) throw new Error('Photo required');
    await image.decode();
    return {
      srcset: image.srcset,
      source: image.src,
      selected: image.currentSrc,
    };
  });
  expect(requestsForPhoto(photo.srcset, photo.source, requests)).toHaveLength(
    1,
  );
  expect(photo.selected).toMatch(/\/800\/auto$/);
  expect(calls).toBe(2);
  await context.close();
});

for (const lateAt of ['before retry', 'after retry'])
  for (const seam of ['headers', 'body'])
    test(`dimension deadline covers held ${seam}, retries and ignores late completion ${lateAt}`, async ({
      browser,
      baseURL,
    }) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 844 },
        deviceScaleFactor: 2,
        colorScheme: 'light',
      });
      await context.route('https://toolbar.bent.build/embed.js', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: '' }),
      );
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      if (seam === 'headers')
        await context.route('**/map-photo/**', async (route) => {
          calls++;
          if (calls === 1) {
            await held;
            await route
              .fulfill({
                contentType: 'application/json',
                body: '{"width":1600,"height":1200}',
              })
              .catch(() => {});
          } else await route.continue();
        });
      await context.addInitScript(
        ({ seam }) => {
          const original = window.fetch.bind(window);
          let calls = 0;
          window.fetch = async (...args) => {
            const selected = (
              args[0] instanceof Request ? args[0].url : args[0].toString()
            ).includes('/map-photo/');
            if (selected)
              args[1]?.signal?.addEventListener('abort', () => {
                document.documentElement.dataset.dimensionAbort = 'yes';
              });
            const response = await original(...args);
            if (!selected || ++calls !== 1 || seam !== 'body') return response;
            document.documentElement.dataset.dimensionBody = 'pending';
            // A transport/body which completes even after abort must not win a later attempt.
            return new Response(
              new ReadableStream({
                start(controller) {
                  window.addEventListener(
                    'release-dimension-body',
                    () => {
                      controller.enqueue(
                        new TextEncoder().encode(
                          '{"width":1600,"height":1200}',
                        ),
                      );
                      controller.close();
                    },
                    { once: true },
                  );
                },
              }),
              { headers: { 'Content-Type': 'application/json' } },
            );
          };
        },
        { seam },
      );
      const page = await context.newPage();
      const photoRequests: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/media-preview/'))
          photoRequests.push(request.url());
      });
      await page.clock.install();
      const evidence = process.env.MAP_IMAGE_EVIDENCE_DIR;
      const stage = async (name: string) => {
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await page.locator('[data-feedback-id="map-preview"]').screenshot({
            path: `${evidence}/deadline-${seam}-${lateAt.replace(' ', '-')}-${name}.png`,
          });
        }
      };
      try {
        await page.goto(
          `${baseURL || ''}/?media=${fixtureIds[0] || ''}#japan-map`,
        );
        const popup = page.locator('[data-feedback-id="map-preview"]');
        if (seam === 'headers') await expect.poll(() => calls).toBe(1);
        else
          await expect(page.locator('html')).toHaveAttribute(
            'data-dimension-body',
            'pending',
          );
        await expect(
          popup.locator('[data-map-photo="active"] img'),
        ).toHaveCount(0);
        await stage('loading');
        await page.clock.fastForward(10_000);
        await expect(
          popup.getByRole('button', { name: 'RETRY PHOTO' }),
        ).toBeVisible({ timeout: 1000 });
        await stage('deadline');
        await expect(
          popup.locator('[data-map-photo="active"] img'),
        ).toHaveCount(0);
        await expect(page.locator('html')).toHaveAttribute(
          'data-dimension-abort',
          'yes',
        );
        const finishLate = async () => {
          release();
          await page.evaluate(() =>
            window.dispatchEvent(new Event('release-dimension-body')),
          );
          await page.clock.runFor(100);
        };
        if (lateAt === 'before retry') {
          await finishLate();
          await expect(
            popup.getByRole('button', { name: 'RETRY PHOTO' }),
          ).toBeVisible();
          await expect(
            popup.locator('[data-map-photo="active"] img'),
          ).toHaveCount(0);
        }
        await popup.getByRole('button', { name: 'RETRY PHOTO' }).click();
        await stage('retry-loading');
        await page.clock.runFor(100);
        const image = popup.locator('[data-map-photo="active"] img');
        await expect(image).toBeVisible();
        await image.evaluate(async (image) => {
          if (image instanceof HTMLImageElement) await image.decode();
        });
        await expect
          .poll(() =>
            image.evaluate((image) =>
              image instanceof HTMLImageElement ? image.currentSrc : '',
            ),
          )
          .toMatch(/\/800\/auto$/);
        await stage('retry-loaded');
        if (lateAt === 'after retry') await finishLate();
        const photo = await image.evaluate((image) => {
          if (!(image instanceof HTMLImageElement))
            throw new Error('Photo required');
          return { srcset: image.srcset, source: image.src };
        });
        expect(
          requestsForPhoto(photo.srcset, photo.source, photoRequests),
        ).toHaveLength(1);
        await expect(image).toHaveAttribute('sizes', /41.25dvh/);
        await expect
          .poll(() =>
            image.evaluate((image) =>
              image instanceof HTMLImageElement ? image.currentSrc : '',
            ),
          )
          .toMatch(/\/800\/auto$/);
      } finally {
        release();
        await context.close();
      }
    });

for (const action of ['selection', 'close', 'unmount'])
  test(`obsolete JSON body after ${action} cannot expose retry or overwrite the active photo`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 844 },
      deviceScaleFactor: 2,
    });
    await context.route('https://toolbar.bent.build/embed.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      let held = false;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (
          !(
            args[0] instanceof Request ? args[0].url : args[0].toString()
          ).includes('/map-photo/') ||
          held
        )
          return response;
        held = true;
        document.documentElement.dataset.dimensionBody = 'pending';
        args[1]?.signal?.addEventListener('abort', () => {
          document.documentElement.dataset.dimensionAbort = 'yes';
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              window.addEventListener(
                'release-dimension-body',
                () => {
                  controller.enqueue(
                    new TextEncoder().encode('{"width":1,"height":1000}'),
                  );
                  controller.close();
                },
                { once: true },
              );
            },
          }),
        );
      };
    });
    const page = await context.newPage();
    await page.clock.install();
    try {
      await page.goto(
        `${baseURL || ''}/?media=${fixtureIds[0] || ''}#japan-map`,
      );
      const popup = page.locator('[data-feedback-id="map-preview"]');
      await expect(page.locator('html')).toHaveAttribute(
        'data-dimension-body',
        'pending',
      );
      if (action === 'selection')
        await popup
          .getByRole('button', { name: 'Next media at this location' })
          .click();
      else if (action === 'close')
        await popup.getByRole('button', { name: 'Close map preview' }).click();
      else
        await page
          .locator('astro-island[component-export="JapanMapView"]')
          .evaluate((island) =>
            island.dispatchEvent(new Event('astro:unmount')),
          );
      await expect(page.locator('html')).toHaveAttribute(
        'data-dimension-abort',
        'yes',
      );
      await page.evaluate(() =>
        window.dispatchEvent(new Event('release-dimension-body')),
      );
      await page.clock.runFor(100);
      if (action === 'selection') {
        await expect(
          popup.locator('[data-map-photo="active"] img'),
        ).toBeVisible();
        await expect(
          popup.locator('[data-map-photo="active"] img'),
        ).toHaveAttribute('alt', /^Synthetic (landscape|square)$/);
        await expect(
          popup.locator('[data-map-photo="active"] img'),
        ).toHaveAttribute('sizes', /(?:73.33333333333333|55)dvh/);
      } else await expect(popup).toHaveCount(0);
      await page.clock.fastForward(10_000);
      await expect(
        page.getByRole('button', { name: 'RETRY PHOTO' }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

for (const librarySize of [102, 600])
  test(
    librarySize === 600
      ? 'a 600-photo published library retains the last native photo and its first measured candidate'
      : 'a final-page native photo retains its first measured candidate in a representative library',
    async ({
      request: sharedRequest,
      browser,
      playwright,
      baseURL: sharedBaseURL,
    }) => {
      test.setTimeout(120_000);
      // A representative library owns its runtime, including CMS background work.
      // Disposing it avoids leaking hundreds of fixture lifecycle jobs into other tests.
      await sharedRequest.get('/_emdash/api/auth/dev-bypass');
      const original = z
        .object({
          data: z.object({
            item: z.object({ data: z.record(z.string(), z.unknown()) }),
          }),
        })
        .parse(
          await (
            await sharedRequest.get(
              `/_emdash/api/content/media_items/${fixtureIds[0] || ''}`,
            )
          ).json(),
        ).data.item.data;
      const sourcePage = await browser.newPage();
      await sourcePage.route('https://toolbar.bent.build/embed.js', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: '' }),
      );
      await sourcePage.goto(
        `${sharedBaseURL || ''}/?media=${fixtureIds[0] || ''}#japan-map`,
      );
      const sourceImage = sourcePage.locator(
        '[data-feedback-id="map-preview"] [data-map-photo="active"] img',
      );
      await expect(sourceImage).toBeVisible();
      const source = await sourceImage.getAttribute('src');
      expect(source).toMatch(/^\/_emdash\/api\/media\/file\/trip\//);
      const display = await sharedRequest.get(source || '');
      expect(display.ok()).toBe(true);
      const bytes = await display.body();
      await sourcePage.close();
      const runtime = startIsolatedBrowserServer(
        process.env.MAP_IMAGE_EVIDENCE_DIR
          ? join(process.env.MAP_IMAGE_EVIDENCE_DIR, 'library-server.log')
          : test.info().outputPath('library-server.log'),
        {
          configFile: 'tests/fixtures/map-library.config.mjs',
          additionalInputs: [
            'tests/fixtures/map-library.config.mjs',
            'tests/fixtures/map-library-endpoint.ts',
          ],
        },
      );
      try {
        const { baseURL } = await runtime.ready;
        const request = await playwright.request.newContext({ baseURL });
        try {
          const context = await browser.newContext({
            viewport: { width: 1991, height: 844 },
            deviceScaleFactor: 2,
            colorScheme: 'dark',
          });
          try {
            const headers = { 'X-EmDash-Request': '1', Origin: baseURL };
            expect(
              (
                await request.post('/_emdash/api/setup/dev-bypass', {
                  headers,
                  data: {},
                })
              ).ok(),
            ).toBe(true);
            await request.get('/_emdash/api/auth/dev-bypass');
            const file = {
              name: 'synthetic-library.jpg',
              mimeType: 'image/jpeg',
              buffer: bytes,
            };
            const uploaded = await request.post('/api/trip/upload', {
              headers,
              multipart: { original: file, display: file, poster: file },
            });
            expect(uploaded.status()).toBe(201);
            const id = z
              .object({
                data: z.object({ item: z.object({ id: z.string() }) }),
              })
              .parse(await uploaded.json()).data.item.id;
            const loaded = await request.get(
              `/_emdash/api/content/media_items/${id}`,
            );
            const native = result.parse(await loaded.json()).data;
            const media = z
              .object({
                data: z.object({
                  item: z.object({ data: z.record(z.string(), z.unknown()) }),
                }),
              })
              .parse(await loaded.json()).data.item.data;
            const data = {
              ...media,
              title: 'Synthetic library photo',
              captured_at: original.captured_at,
              latitude: original.latitude,
              longitude: original.longitude,
              place: original.place,
              categories: [],
              demo: true,
            };
            expect(
              (
                await request.put(`/_emdash/api/content/media_items/${id}`, {
                  headers,
                  data: { _rev: native._rev, data },
                })
              ).ok(),
            ).toBe(true);
            const revision = result.parse(
              await (
                await request.get(`/_emdash/api/content/media_items/${id}`)
              ).json(),
            ).data._rev;
            expect(
              (
                await request.post(
                  `/_emdash/api/content/media_items/${id}/publish`,
                  {
                    headers,
                    data: { _rev: revision },
                  },
                )
              ).ok(),
            ).toBe(true);
            const libraryIds =
              await test.step(`measure: seed ${String(librarySize)}-photo library in ephemeral D1`, async () => {
                const seeded = await request.post(
                  `/__synthetic/map-library?sourceId=${id}&copies=${String(librarySize - 1)}`,
                  {
                    headers,
                  },
                );
                expect(seeded.ok()).toBe(true);
                const { ids } = z
                  .object({ ids: z.array(z.string()).length(librarySize - 1) })
                  .parse(await seeded.json());
                return [id, ...ids];
              });
            const nativeIds: string[] = [];
            const pageSizes: number[] = [];
            const cursors = new Set<string>();
            let cursor: string | undefined;
            do {
              const response = await request.get(
                `/_emdash/api/content/media_items?status=published&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
              );
              expect(response.ok()).toBe(true);
              const page = z
                .object({
                  data: z.object({
                    items: z.array(
                      z.object({
                        id: z.string(),
                        status: z.literal('published'),
                      }),
                    ),
                    nextCursor: z.string().nullish(),
                  }),
                })
                .parse(await response.json()).data;
              nativeIds.push(...page.items.map((item) => item.id));
              pageSizes.push(page.items.length);
              cursor = page.nextCursor ?? undefined;
              if (cursor) {
                expect(cursors.has(cursor)).toBe(false);
                cursors.add(cursor);
              }
            } while (cursor);
            expect(nativeIds).toHaveLength(librarySize);
            expect(new Set(nativeIds)).toEqual(new Set(libraryIds));
            expect(pageSizes).toEqual(
              librarySize === 600 ? [100, 100, 100, 100, 100, 100] : [100, 2],
            );
            const finalId = libraryIds.at(-1);
            const final = await request.get(
              `/_emdash/api/content/media_items/${finalId || ''}`,
            );
            expect(final.ok()).toBe(true);
            const identity = z
              .object({
                data: z.object({
                  item: z.object({
                    id: z.string(),
                    status: z.literal('published'),
                    data: z.object({ asset: z.unknown() }),
                  }),
                }),
              })
              .parse(await final.json()).data.item;
            expect(identity.id).toBe(finalId);
            expect(identity.data.asset).toEqual(media.asset);
            await context.route(
              'https://toolbar.bent.build/embed.js',
              (route) =>
                route.fulfill({
                  contentType: 'application/javascript',
                  body: '',
                }),
            );
            const page = await context.newPage();
            const resolutions: string[] = [];
            const requests: string[] = [];
            page.on('request', (r) => {
              if (r.url().includes('/map-photo/')) resolutions.push(r.url());
              if (r.url().includes('/media-preview/')) requests.push(r.url());
            });
            const response = await page.goto(
              `${baseURL}/?media=${libraryIds.at(-1) || ''}#japan-map`,
            );
            expect(response?.headers()['cache-control']).toContain('no-store');
            const serializedPoints = await page
              .locator('astro-island[component-export="JapanMapView"]')
              .getAttribute('props');
            for (const entryId of libraryIds)
              expect(serializedPoints).toContain(entryId);
            const popup = page.locator('[data-feedback-id="map-preview"]');
            const image = popup.locator('[data-map-photo="active"] img');
            await expect(image).toBeVisible();
            const photo = await image.evaluate(async (image) => {
              if (!(image instanceof HTMLImageElement))
                throw new Error('Photo required');
              await image.decode();
              return {
                srcset: image.srcset,
                source: image.src,
                selected: image.currentSrc,
              };
            });
            expect(photo.selected).toMatch(/\/800\/auto$/);
            const controlContext = await browser.newContext({
              deviceScaleFactor: 2,
            });
            try {
              const control = await controlContext.newPage();
              await control.goto(`${baseURL}/_emdash/api/health`);
              const measuredWidth = await image.evaluate(
                (image) => image.getBoundingClientRect().width,
              );
              const selected = await control.evaluate(
                async ({ width, srcset }) => {
                  const image = new Image();
                  image.sizes = `${String(width)}px`;
                  image.srcset = srcset;
                  await image.decode();
                  return image.currentSrc;
                },
                { width: measuredWidth, srcset: photo.srcset },
              );
              expect(photo.selected).toBe(selected);
            } finally {
              await controlContext.close();
            }
            expect(
              resolutions.filter((url) =>
                url.includes(`/map-photo/${finalId || ''}/`),
              ),
            ).toHaveLength(1);
            expect(resolutions.length).toBeLessThanOrEqual(3);
            expect(
              requestsForPhoto(photo.srcset, photo.source, requests),
            ).toHaveLength(1);
            expect(await popup.getByRole('heading').innerText()).toContain(
              String(librarySize),
            );
          } finally {
            await context.close();
          }
        } finally {
          await request.dispose();
        }
      } finally {
        await runtime.stop();
      }
    },
  );

test.afterAll(async ({ request, baseURL }) => {
  await request.get('/_emdash/api/auth/dev-bypass');
  for (const id of fixtureIds)
    expect(
      (
        await request.delete(`/_emdash/api/content/media_items/${id}`, {
          headers: { 'X-EmDash-Request': '1', Origin: baseURL || '' },
        })
      ).ok(),
    ).toBe(true);
});
