import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { settleMasonry } from '../fixtures/masonry-layout';

const createdSchema = z.object({
  data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
});
const run = crypto.randomUUID();
const media: { id: string; slug: string; title: string }[] = [];
const posts: { id: string; slug: string; count: number }[] = [];
const design = {
  productUrl:
    'https://shop.bent.build/product/00000000-0000-4000-8000-000000000001',
  color: 'white',
};

test.beforeAll(async ({ request, baseURL }) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  expect(
    (
      await request.post('/_emdash/api/setup/dev-bypass', { headers, data: {} })
    ).ok(),
  ).toBe(true);
  await request.get('/_emdash/api/auth/dev-bypass');
  async function create(
    collection: string,
    slug: string,
    data: Record<string, unknown>,
  ) {
    const response = await request.post(`/_emdash/api/content/${collection}`, {
      headers,
      data: { slug, data },
    });
    expect(response.status()).toBe(201);
    const { item, _rev } = createdSchema.parse(await response.json()).data;
    expect(
      (
        await request.post(
          `/_emdash/api/content/${collection}/${item.id}/publish`,
          { headers, data: { _rev } },
        )
      ).ok(),
    ).toBe(true);
    return item.id;
  }
  for (const [index, shape] of [
    'portrait',
    'landscape',
    'portrait',
    'landscape',
    'portrait',
    'landscape',
    'tall',
  ].entries()) {
    const slug = `synthetic-mosaic-${run}-${String(index)}`;
    const title = `Synthetic mosaic ${String(index + 1)} ${shape}`;
    const video = index >= 4;
    const id = await create('media_items', slug, {
      title,
      kind: video ? 'video' : 'photo',
      captured_at: '2099-10-15T00:00:00Z',
      latitude: 27.1,
      longitude: 128.4,
      place: 'synthetic fixture',
      categories: [],
      demo: true,
      source_url: `/demo/mosaic-${shape}.${video ? 'mp4' : 'svg'}`,
      poster_url: `/demo/mosaic-${shape}.svg`,
      duration: video ? 6 : null,
    });
    media.push({ id, slug, title });
  }
  for (const count of [0, 1, 2, 3, 4, 5, 7]) {
    const slug = `synthetic-mosaic-post-${run}-${String(count)}`;
    // Reverse capture/insertion order to detect accidental media sorting.
    const id = await create('posts', slug, {
      title: `Synthetic mosaic ${String(count)}`,
      day: '2099-10-15',
      content: [],
      demo: true,
      gallery: media
        .slice(0, count)
        .reverse()
        .map((item) => item.id),
      ...(count === 7 || count === 0 ? { shop_design: design } : {}),
    });
    posts.push({ id, slug, count });
  }
});

test.afterAll(async ({ request, baseURL }) => {
  await request.get('/_emdash/api/auth/dev-bypass');
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  for (const post of posts)
    expect(
      (
        await request.delete(`/_emdash/api/content/posts/${post.id}`, {
          headers,
        })
      ).ok(),
    ).toBe(true);
  for (const item of media)
    expect(
      (
        await request.delete(`/_emdash/api/content/media_items/${item.id}`, {
          headers,
        })
      ).ok(),
    ).toBe(true);
});

test.beforeEach(async ({ page }) => {
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.route(
    'https://shop.bent.build/api/configured-product-image/**',
    (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="100%" height="100%" fill="white"/><text x="20" y="150" fill="#0647ff">synthetic shirt</text></svg>',
      }),
  );
  await page.route('**/demo/mosaic-*.svg', (route) => {
    const shape = route.request().url().includes('landscape')
      ? 'landscape'
      : route.request().url().includes('tall')
        ? 'tall'
        : 'portrait';
    const width = shape === 'landscape' ? 360 : 180;
    const height = shape === 'landscape' ? 180 : shape === 'tall' ? 540 : 270;
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}"><rect width="100%" height="100%" fill="#c8edda"/><circle cx="90" cy="90" r="50" fill="#0647ff"/></svg>`,
    });
  });
  await page.route('**/demo/mosaic-*.mp4', async (route) => {
    const shape = route.request().url().includes('landscape')
      ? 'landscape'
      : route.request().url().includes('tall')
        ? 'tall'
        : 'portrait';
    const bytes = await readFile(
      new URL(`../fixtures/map-${shape}.mp4`, import.meta.url),
    );
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers()['range'] || '',
    );
    const start = Number(range?.[1] || 0);
    const end = Math.min(
      Number(range?.[2] || bytes.length - 1),
      bytes.length - 1,
    );
    await route.fulfill({
      status: range ? 206 : 200,
      contentType: 'video/mp4',
      headers: {
        'Accept-Ranges': 'bytes',
        ...(range
          ? {
              'Content-Range': `bytes ${String(start)}-${String(end)}/${String(bytes.length)}`,
            }
          : {}),
      },
      body: bytes.subarray(start, end + 1),
    });
  });
});

for (const width of [320, 390, 585, 601, 848, 1991]) {
  for (const colorScheme of ['light', 'dark']) {
    test(`mosaic preserves ordered, accessible media at ${String(width)}px in ${colorScheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width,
        height: width === 1991 ? 1138 : 844,
      });
      await page.emulateMedia({
        colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      for (const post of posts) {
        const response = await page.goto(`/posts/${post.slug}`);
        expect(response?.status()).toBe(200);
        await expect(page.locator('h1')).toHaveText(
          `Synthetic mosaic ${String(post.count)}`,
        );
        const mosaic = page.getByRole('region', {
          name: `Synthetic mosaic ${String(post.count)} media`,
          exact: true,
        });
        const tiles = mosaic.locator('.media-tile');
        await expect(tiles).toHaveCount(post.count);
        await expect(page.locator('.post-carousel')).toHaveCount(0);
        const expected = media.slice(0, post.count).reverse();
        expect(
          await tiles.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-feedback-id')),
          ),
        ).toEqual(expected.map((item) => `media-${item.id}`));
        for (const photo of await mosaic.locator('.media-tile img').all())
          await expect(photo).toHaveAttribute('loading', 'lazy');
        await mosaic.locator('img').evaluateAll(async (images) => {
          await Promise.all(
            images.map(async (image) => {
              if (image instanceof HTMLImageElement) {
                image.loading = 'eager';
                await image.decode();
              }
            }),
          );
        });
        // Deferred videos load when the reader reaches them. Exercise that
        // transition before checking the layout with intrinsic dimensions.
        for (const video of await mosaic.locator('video').all()) {
          await expect(video).toHaveAttribute('preload', 'none');
          await video.scrollIntoViewIfNeeded();
          await expect
            .poll(() =>
              video.evaluate((element) =>
                element instanceof HTMLVideoElement ? element.readyState : 0,
              ),
            )
            .toBeGreaterThanOrEqual(1);
        }
        await page.evaluate(() => {
          scrollTo(0, 0);
        });
        await settleMasonry(mosaic.locator('[data-masonry]'));
        const boxes: { x: number; y: number; width: number; height: number }[] =
          [];
        for (const [index, item] of expected.entries()) {
          const tile = tiles.nth(index);
          const link = tile
            .getByRole('link')
            .or(tile.and(page.getByRole('link')));
          await expect(link).toHaveAttribute('href', `/media/${item.slug}`);
          const photo = tile.getByRole('img');
          if (await photo.count()) {
            await expect(photo).toHaveAttribute('alt', item.title);
            await photo.evaluate(async (element) => {
              if (element instanceof HTMLImageElement) {
                element.loading = 'eager';
                await element.decode();
              }
            });
            await expect(photo).toHaveCSS('object-fit', 'contain');
          } else {
            await expect(
              tile.getByLabel(item.title, { exact: true }),
            ).toHaveAttribute('controls', '');
          }
          const box = await tile.boundingBox();
          if (!box) throw new Error('Visible mosaic media required');
          const previous = boxes.at(-1);
          if (previous)
            expect(
              box.y > previous.y + 1 ||
                (Math.abs(box.y - previous.y) <= 1 && box.x > previous.x),
            ).toBe(true);
          boxes.push(box);
        }
        const first = boxes[0];
        const second = boxes[1];
        const third = boxes[2];
        if (first && second) {
          if (width < 601)
            expect(second.y).toBeGreaterThan(first.y + first.height);
          else if (
            (post.count + (post.count === 7 ? 1 : 0)) % 2 === 1 &&
            third
          ) {
            expect(first.width).toBeGreaterThan(second.width * 1.9);
            expect(second.y).toBeGreaterThanOrEqual(first.y + first.height + 6);
            expect(third.width).toBeCloseTo(second.width, 0);
          } else {
            expect(first.width).toBeCloseTo(second.width, 0);
          }
        }
        if (post.count === 0 || post.count === 7) {
          const shop = mosaic.getByRole('link', {
            name: 'Shop this design on a white t-shirt',
          });
          await expect(shop).toHaveAttribute('href', /Color=White/);
          if (boxes.length) {
            const design = mosaic.locator('.post-design');
            const box = await design.boundingBox();
            const last = boxes.at(-1);
            if (!box || !last) throw new Error('Design bounds required');
            expect(box.width).toBeCloseTo(last.width, 0);
            expect(
              box.y > last.y + 1 ||
                (Math.abs(box.y - last.y) <= 1 && box.x > last.x),
            ).toBe(true);
            const columnOrder = await design.evaluate((element) =>
              Array.from(
                element.parentElement?.parentElement?.children ?? [],
              ).map((tile) =>
                tile
                  .querySelector('[data-feedback-id]')
                  ?.getAttribute('data-feedback-id'),
              ),
            );
            expect(columnOrder).toEqual([
              ...expected.map((item) => `media-${item.id}`),
              'post-design',
            ]);
          }
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        const article = await page.locator('article').boundingBox();
        if (!article) throw new Error('Post required');
        expect(article.x).toBeGreaterThanOrEqual(width < 601 ? 16 : 24);
        expect(article.width).toBeLessThanOrEqual(800);
      }
    });
  }
}

for (const width of [390, 601, 1280]) {
  test(`mosaic video keeps native playback, seeking, visibility and media navigation at ${String(width)}px`, async ({
    page,
  }) => {
    const post = posts.find((post) => post.count === 7);
    if (!post) throw new Error('Mixed media post required');
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/posts/${post.slug}`);
    const videos = page.locator('.post-mosaic video');
    await expect(videos).toHaveCount(3);
    for (const video of await videos.all()) {
      await video.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          video.evaluate((element) =>
            element instanceof HTMLVideoElement ? element.readyState : 0,
          ),
        )
        .toBeGreaterThanOrEqual(2);
      await expect(video).toHaveAttribute('playsinline', '');
      await video.evaluate(async (element) => {
        if (!(element instanceof HTMLVideoElement))
          throw new Error('Video required');
        element.muted = true;
        await element.play();
      });
      await expect
        .poll(() =>
          video.evaluate(
            (element) => element instanceof HTMLVideoElement && !element.paused,
          ),
        )
        .toBe(true);
      await video.press('Space');
      await expect
        .poll(() =>
          video.evaluate(
            (element) => element instanceof HTMLVideoElement && element.paused,
          ),
        )
        .toBe(true);
      await video.press('Space');
      await expect
        .poll(() =>
          video.evaluate(
            (element) => element instanceof HTMLVideoElement && !element.paused,
          ),
        )
        .toBe(true);
      await video.evaluate((element) => {
        if (element instanceof HTMLVideoElement) {
          element.pause();
          element.currentTime = 2;
        }
      });
      await expect
        .poll(() =>
          video.evaluate((element) =>
            element instanceof HTMLVideoElement ? element.currentTime : 0,
          ),
        )
        .toBeCloseTo(2, 1);
      await page.evaluate(() => {
        scrollTo(0, document.documentElement.scrollHeight);
      });
      await expect
        .poll(() =>
          video.evaluate(
            (element) => element instanceof HTMLVideoElement && element.paused,
          ),
        )
        .toBe(true);
    }
    const first = media[0];
    if (!first) throw new Error('Photo required');
    const photo = page.getByRole('link', { name: first.title, exact: true });
    await photo.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/media/${first.slug}$`));
    await expect(
      page.getByRole('img', { name: first.title, exact: true }),
    ).toBeVisible();
  });
}

for (const width of [390, 1991]) {
  for (const colorScheme of ['light', 'dark']) {
    test(`mosaic packs mixed media without row-height gaps at ${String(width)}px in ${colorScheme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({
        width,
        height: width === 1991 ? 1138 : 844,
      });
      await page.emulateMedia({
        colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      const metadataReady = Promise.withResolvers<undefined>();
      let heldMetadata = 0;
      await page.route('**/demo/mosaic-tall.mp4', async (route) => {
        heldMetadata++;
        await metadataReady.promise;
        await route.fallback();
      });
      // A landscape placeholder deliberately differs from the tall video's
      // intrinsic ratio. Native metadata must trigger a second packing pass.
      await page.route('**/demo/mosaic-tall.svg', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180"><rect width="100%" height="100%" fill="#adc4ff"/></svg>',
        }),
      );
      try {
        for (const count of [4, 7]) {
          const post = posts.find((post) => post.count === count);
          if (!post) throw new Error('Mixed mosaic fixture required');
          await page.goto(`/posts/${post.slug}`);
          const mosaic = page.locator('.post-mosaic');
          await mosaic.locator('img').evaluateAll(async (images) => {
            await Promise.all(
              images.map(async (image) => {
                if (!(image instanceof HTMLImageElement))
                  throw new Error('Image required');
                image.loading = 'eager';
                await image.decode();
              }),
            );
          });
          let placeholderHeight = 0;
          if (count === 7) {
            await expect(mosaic.locator('.media-tile')).toHaveCount(7);
            await expect(mosaic.locator('.post-design')).toHaveCount(1);
            await mosaic.locator('video').first().scrollIntoViewIfNeeded();
            await expect.poll(() => heldMetadata).toBeGreaterThan(0);
            const held = mosaic.locator('video').first();
            expect(
              await held.evaluate((video) =>
                video instanceof HTMLVideoElement ? video.readyState : -1,
              ),
            ).toBe(0);
            placeholderHeight = await held.evaluate(
              (video) => video.getBoundingClientRect().height,
            );
            metadataReady.resolve(undefined);
          }
          for (const video of await mosaic.locator('video').all()) {
            await expect(video).toHaveAttribute('preload', 'none');
            await video.scrollIntoViewIfNeeded();
            await expect
              .poll(() =>
                video.evaluate((element) =>
                  element instanceof HTMLVideoElement ? element.readyState : 0,
                ),
              )
              .toBeGreaterThanOrEqual(2);
          }
          await page.evaluate(() => {
            scrollTo(0, 0);
          });
          if (count === 7) {
            const held = mosaic.locator('video').first();
            expect(
              await held.evaluate(
                (video) => video.getBoundingClientRect().height,
              ),
            ).toBeGreaterThan(placeholderHeight + 50);
            for (const video of await mosaic.locator('video').all())
              await expect(video).toHaveCSS('object-fit', 'contain');
          }
          await settleMasonry(mosaic.locator('[data-masonry]'));
          const geometry = await mosaic
            .locator('.media-tile, .post-design')
            .evaluateAll((tiles) => {
              const boxes = tiles.map((tile) => {
                const { x, y, width, height } = tile.getBoundingClientRect();
                return { x, y, width, height };
              });
              return boxes.map((box) => {
                const above = boxes.filter(
                  (other) =>
                    other.y + other.height <= box.y + 1 &&
                    other.x < box.x + box.width - 1 &&
                    other.x + other.width > box.x + 1,
                );
                return {
                  ...box,
                  gap: above.length
                    ? box.y -
                      Math.max(...above.map((other) => other.y + other.height))
                    : 0,
                };
              });
            });
          await writeFile(
            testInfo.outputPath(`geometry-${String(count)}.json`),
            JSON.stringify(geometry, null, 2),
          );
          await testInfo.attach(`geometry-${String(count)}`, {
            body: JSON.stringify(geometry, null, 2),
            contentType: 'application/json',
          });
          if (count === 7) {
            const path = testInfo.outputPath('synthetic-mixed-mosaic.png');
            await page
              .locator('article')
              .screenshot({ path, caret: 'initial' });
            await testInfo.attach('synthetic-mixed-mosaic', {
              path,
              contentType: 'image/png',
            });
          }
          for (const box of geometry)
            expect.soft(box.gap).toBeLessThanOrEqual(8);
        }
      } finally {
        metadataReady.resolve(undefined);
      }
    });
  }
}

for (const width of [390, 601, 1991]) {
  test(`mosaic media links retain keyboard order at ${String(width)}px`, async ({
    page,
  }) => {
    const post = posts.find((post) => post.count === 7);
    if (!post) throw new Error('Mixed mosaic fixture required');
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/posts/${post.slug}`);
    const links = page.locator(
      '.post-mosaic .media-tile a, .post-mosaic a.media-tile',
    );
    const expected = media
      .slice(0, 7)
      .reverse()
      .map((item) => `/media/${item.slug}`);
    expect(
      await links.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('href')),
      ),
    ).toEqual(expected);
    await links.first().focus();
    const visited = [expected[0]];
    // Native video controls may add keyboard stops between media links.
    for (
      let stops = 0;
      visited.length < expected.length && stops < 80;
      stops++
    ) {
      await page.keyboard.press('Tab');
      const href = await page.evaluate(() => {
        const element = document.activeElement;
        return element instanceof HTMLAnchorElement &&
          element.closest('.post-mosaic .media-tile')
          ? element.getAttribute('href')
          : null;
      });
      if (href) visited.push(href);
    }
    expect(visited).toEqual(expected);
  });
}

test.describe('CSS post mosaic', () => {
  test.use({ javaScriptEnabled: false });

  test('media query packs initial HTML without application JavaScript', async ({
    page,
  }) => {
    const post = posts.find((post) => post.count === 4);
    if (!post) throw new Error('Even mosaic fixture required');
    for (const width of [390, 600, 601, 1991]) {
      await page.setViewportSize({ width, height: 1138 });
      await page.goto(`/posts/${post.slug}`);
      await expect(page.locator('.post-mosaic > div').first()).toHaveCSS(
        'display',
        'grid',
      );
      await expect(page.locator('.post-mosaic .media-tile')).toHaveCount(4);
      await page.locator('.post-mosaic img').evaluateAll(async (images) => {
        await Promise.all(
          images.map(async (image) => {
            if (!(image instanceof HTMLImageElement))
              throw new Error('Photo required');
            image.loading = 'eager';
            await image.decode();
          }),
        );
      });
      const boxes = await page
        .locator('.post-mosaic .media-tile')
        .evaluateAll((tiles) =>
          tiles.map((tile) => {
            const { x, y, height } = tile.getBoundingClientRect();
            return { x, y, height };
          }),
        );
      for (const [index, box] of boxes.entries()) {
        const prior = boxes[index - 1];
        if (prior)
          expect(
            box.y > prior.y + 1 ||
              (Math.abs(box.y - prior.y) <= 1 && box.x > prior.x),
          ).toBe(true);
        const above = boxes
          .slice(0, index)
          .filter((other) => other.y < box.y - 1);
        if (above.length)
          expect(
            box.y - Math.max(...above.map((other) => other.y + other.height)),
          ).toBeCloseTo(7, 0);
      }
    }
  });

  test('named post container controls columns independently of desktop viewport', async ({
    page,
  }) => {
    const post = posts.find((post) => post.count === 7);
    if (!post) throw new Error('Odd mosaic fixture required');
    await page.setViewportSize({ width: 1991, height: 1138 });
    await page.goto(`/posts/${post.slug}`);
    for (const width of [552, 553, 800]) {
      await page.locator('article').evaluate((article, width) => {
        if (!(article instanceof HTMLElement)) throw new Error('Post required');
        article.style.width = `${String(width)}px`;
      }, width);
      await expect(page.locator('.post-mosaic > div').first()).toHaveCSS(
        'grid-template-columns',
        width < 553
          ? `${String(width)}px`
          : `${String((width - 7) / 2)}px ${String((width - 7) / 2)}px`,
      );
      await expect(page.locator('.post-mosaic .media-tile')).toHaveCount(7);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(1991);
    }
  });
});
