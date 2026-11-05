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

test('native inline galleries select fresh candidates for their actual slots', async ({
  page,
  request,
  baseURL,
  browser,
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
  for (const [width, height] of [
    [1200, 1600],
    [1600, 1200],
  ]) {
    if (!width || !height) throw new Error('Fixture dimensions required');
    const jpeg =
      await test.step(`measure: inline JPEG generation ${String(width)}x${String(height)}`, () =>
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
    const file = {
      name: 'synthetic-responsive.jpg',
      mimeType: 'image/jpeg',
      buffer,
    };
    const uploaded = await test.step('measure: inline media upload', () =>
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
  const post = await test.step('measure: inline post fixture creation', () =>
    request.post('/_emdash/api/content/posts', {
      headers,
      data: {
        slug: postSlug,
        data: {
          title: 'Synthetic responsive images',
          day: '2099-10-15',
          content: [2, 3].map((columns, index) => ({
            _type: 'gallery',
            _key: `synthetic-gallery-${String(columns)}`,
            columns,
            images: Array.from({ length: columns }, (_, image) => ({
              _type: 'image',
              _key: `synthetic-${String(columns)}-${String(image)}`,
              asset: { _ref: assetIds[index] },
              alt: `Synthetic ${String(columns)} column photo ${String(image)}`,
            })),
          })),
          gallery: [],
          demo: true,
        },
      },
    }));
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
  const measurements: unknown[] = [];
  const failures: string[] = [];
  test.setTimeout(180_000);
  for (const width of [390, 600, 601, 848, 900, 901, 1280, 1400, 1600])
    for (const deviceScaleFactor of [1, 2]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        deviceScaleFactor,
        reducedMotion: 'reduce',
      });
      await context.route('https://toolbar.bent.build/embed.js', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: '' }),
      );
      for (const route of ['home', 'post']) {
        // New contexts isolate source selection from previously loaded larger
        // resources. The control below also uses a distinct native asset URL.
        const fresh = await context.newPage();
        const requests: string[] = [];
        fresh.on('request', (request) => {
          requests.push(request.url());
        });
        await fresh.goto(
          `${baseURL || ''}${route === 'home' ? '/' : `/posts/${postSlug}`}`,
        );
        for (const [index, columns] of [2, 3].entries()) {
          const photo = fresh.getByRole('img', {
            name: `Synthetic ${String(columns)} column photo 0`,
            exact: true,
          });
          const measured = await photo.evaluate(async (image, assetId) => {
            if (!(image instanceof HTMLImageElement))
              throw new Error('Image required');
            image.loading = 'eager';
            await image.decode();
            const width = image.getBoundingClientRect().width;
            const size =
              image.sizes
                .split(',')
                .map((value) => value.trim())
                .find((value) => {
                  const media = value.match(/^(\(min-width: [0-9]+px\)) /);
                  return !media || matchMedia(media[1] || '').matches;
                }) || '';
            const probe = document.createElement('div');
            probe.style.width = size.replace(/^\(min-width: [0-9]+px\) /, '');
            document.body.append(probe);
            const declaredWidth = probe.getBoundingClientRect().width;
            probe.remove();
            const control = new Image();
            control.sizes = `${String(width)}px`;
            control.srcset = image.srcset.replace(
              /file\/[^/]+\/photo\.jpg/g,
              `asset/${assetId}`,
            );
            document.body.append(control);
            await control.decode();
            const expected = control.currentSrc.split('/').at(-2);
            control.remove();
            return {
              width,
              declaredWidth,
              candidate: image.currentSrc.split('/').at(-2),
              expected,
              sizes: image.sizes,
              srcset: image.srcset,
              source: image.src,
              firstImageStartMs: performance.getEntriesByName(
                image.currentSrc,
              )[0]?.startTime,
            };
          }, assetIds[index] || '');
          const candidates = measured.srcset
            .split(',')
            .map((candidate) => candidate.trim().split(' ')[0])
            .filter((value) => Boolean(value));
          const imageRequests = requests.filter(
            (url) =>
              url === measured.source ||
              candidates.some(
                (candidate) => candidate && url.endsWith(candidate),
              ),
          );
          expect(imageRequests).toHaveLength(1);
          measurements.push({
            route,
            viewport: width,
            deviceScaleFactor,
            columns,
            ...measured,
            firstRequestCount: imageRequests.length,
          });
          if (Math.abs(measured.width - measured.declaredWidth) > 1)
            failures.push(
              `${route} ${String(width)}px DPR${String(deviceScaleFactor)} ${String(columns)}cols: slot ${String(measured.width)}, declared ${String(measured.declaredWidth)}`,
            );
          if (measured.candidate !== measured.expected)
            failures.push(
              `${route} ${String(width)}px DPR${String(deviceScaleFactor)} ${String(columns)}cols: candidate ${measured.candidate || 'missing'}, expected ${measured.expected || 'missing'}`,
            );
        }
        if (evidence && [390, 1280].includes(width) && deviceScaleFactor === 1)
          for (const colorScheme of ['light', 'dark']) {
            if (colorScheme !== 'light' && colorScheme !== 'dark')
              throw new Error('Theme required');
            await fresh.emulateMedia({ colorScheme });
            const content = fresh.locator(
              route === 'home'
                ? `[data-feedback-id="post-${fixturePostId}"]`
                : '.single-post',
            );
            await content.screenshot({
              caret: 'initial',
              path: `${evidence}/${String(width)}-${colorScheme}-${route}-galleries.png`,
            });
          }
        await fresh.close();
      }
      await context.close();
    }
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/inline-gallery-measurements.json`,
      JSON.stringify({ synthetic: true, measurements, failures }, null, 2),
    );
  }
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
