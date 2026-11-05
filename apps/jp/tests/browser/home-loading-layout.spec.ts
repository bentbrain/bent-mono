import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';

const run = crypto.randomUUID();
const posts: string[] = [];
const media: string[] = [];
const postCount = 24;
const created = z.object({
  data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
});

test.beforeAll(async ({ request, baseURL }) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  expect(
    (
      await request.post('/_emdash/api/setup/dev-bypass', { headers, data: {} })
    ).ok(),
  ).toBe(true);
  await request.get('/_emdash/api/auth/dev-bypass');
  async function publish(
    collection: string,
    slug: string,
    data: Record<string, unknown>,
  ) {
    const response = await request.post(`/_emdash/api/content/${collection}`, {
      headers,
      data: { slug: `${slug}-${run}`, data },
    });
    expect(response.ok()).toBe(true);
    const { item, _rev } = created.parse(await response.json()).data;
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
  for (let index = 0; index < postCount * 2; index++)
    media.push(
      await publish('media_items', `loading-photo-${String(index)}`, {
        title: `Synthetic loading photo ${String(index)}`,
        kind: 'photo',
        captured_at: '2099-10-15T00:00:00Z',
        latitude: 35.6,
        longitude: 139.7,
        place: 'synthetic fixture',
        categories: [],
        demo: true,
        source_url: `/demo/loading-${String(index)}.svg`,
      }),
    );
  for (let index = 0; index < postCount; index++)
    posts.push(
      await publish('posts', `loading-post-${String(index)}`, {
        title: `Synthetic loading post ${String(index + 1)}`,
        day: `2099-10-${String(31 - index).padStart(2, '0')}`,
        gallery: media.slice(index * 2, index * 2 + 2),
        demo: true,
        content: Array.from({ length: (index % 3) + 1 }, (_, paragraph) => ({
          _type: 'block',
          _key: `paragraph-${String(paragraph)}`,
          style: 'normal',
          markDefs: [],
          children: [
            {
              _type: 'span',
              _key: 'text',
              marks: [],
              text: 'Synthetic text to measure the homepage cards while scripts and photos are still loading. Cards must reserve their space and keep the next post readable.',
            },
          ],
        })),
      }),
    );
});

test.afterAll(async ({ request, baseURL }) => {
  await request.get('/_emdash/api/auth/dev-bypass');
  for (const [collection, ids] of [
    ['posts', posts],
    ['media_items', media],
  ] satisfies [string, string[]][])
    for (const id of ids)
      expect(
        (
          await request.delete(`/_emdash/api/content/${collection}/${id}`, {
            headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
          })
        ).ok(),
      ).toBe(true);
});

async function assertNoOverlap(page: Page) {
  const bounds = await page
    .locator('.journal-card-inner')
    .evaluateAll((cards) =>
      cards.map((card) => {
        const { x, y, width, height } = card.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  expect(bounds.length).toBe(postCount + 1);
  for (let index = 0; index < bounds.length; index++)
    for (const other of bounds.slice(index + 1)) {
      const card = bounds[index];
      if (!card) throw new Error('Card bounds required');
      const overlapWidth =
        Math.min(card.x + card.width, other.x + other.width) -
        Math.max(card.x, other.x);
      const overlapHeight =
        Math.min(card.y + card.height, other.y + other.height) -
        Math.max(card.y, other.y);
      expect(
        overlapWidth > 1 && overlapHeight > 1,
        `cards overlap by ${String(overlapWidth)} × ${String(overlapHeight)}px`,
      ).toBe(false);
    }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => innerWidth),
  );
}

for (const colorScheme of ['light', 'dark'] satisfies ('light' | 'dark')[])
  test(`homepage reserves card space before scripts and images load in ${colorScheme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1991, height: 1138 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    let releaseScripts = () => {};
    let releaseImages = () => {};
    const scripts = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    const images = new Promise<void>((resolve) => {
      releaseImages = resolve;
    });
    const requestedImages = new Set<string>();
    await page.route('**/*', async (route) => {
      if (route.request().url().includes('toolbar.bent.build')) {
        await route.fulfill({
          contentType: 'application/javascript',
          body: '',
        });
      } else if (route.request().resourceType() === 'script') {
        await scripts;
        await route.continue();
      } else if (/\/demo\/loading-\d+\.svg/.test(route.request().url())) {
        requestedImages.add(route.request().url());
        await images;
        await route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#0647ff"/><text x="80" y="400" fill="white" font-size="65">synthetic loading photo</text></svg>',
        });
      } else await route.continue();
    });
    try {
      await page.goto('/', { waitUntil: 'commit' });
      await expect(page.locator('.journal-card-inner')).toHaveCount(
        postCount + 1,
      );
      expect(
        await page
          .locator('.journal-grid')
          .evaluate(
            (grid) =>
              getComputedStyle(grid).gridTemplateColumns.split(' ').length,
          ),
      ).toBe(3);
      await page.evaluate(() => document.fonts.ready);
      if (process.env.HOME_LOADING_EVIDENCE)
        await page.screenshot({
          caret: 'initial',
          path: `${process.env.HOME_LOADING_EVIDENCE}/1991-${colorScheme}-loading.png`,
        });
      if (process.env.HOME_LOADING_EVIDENCE)
        await writeFile(
          `${process.env.HOME_LOADING_EVIDENCE}/${colorScheme}-requests.json`,
          JSON.stringify(
            {
              requestedBeforeScripts: requestedImages.size,
              totalGalleryImages: media.length,
            },
            null,
            2,
          ),
        );
      await assertNoOverlap(page);
      expect(requestedImages.size).toBeLessThan(media.length);
      for (const width of [390, 601, 901, 1991]) {
        await page.setViewportSize({ width, height: 1138 });
        await assertNoOverlap(page);
        if (width === 390 && process.env.HOME_LOADING_EVIDENCE)
          await page.screenshot({
            caret: 'initial',
            path: `${process.env.HOME_LOADING_EVIDENCE}/390-${colorScheme}-loading.png`,
          });
      }
      releaseScripts();
      await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
      for (const width of [1991, 390, 601, 901, 1991]) {
        await page.setViewportSize({ width, height: 1138 });
        await expect
          .poll(() =>
            assertNoOverlap(page)
              .then(() => true)
              .catch(() => false),
          )
          .toBe(true);
      }
      releaseImages();
      await page.locator('article img').evaluateAll(async (nodes) =>
        Promise.all(
          nodes.map(async (node) => {
            if (node instanceof HTMLImageElement) {
              node.loading = 'eager';
              await node.decode();
            }
          }),
        ),
      );
      for (const width of [390, 601, 901, 1991]) {
        await page.setViewportSize({ width, height: 1138 });
        await expect
          .poll(() =>
            assertNoOverlap(page)
              .then(() => true)
              .catch(() => false),
          )
          .toBe(true);
      }
      if (process.env.HOME_LOADING_EVIDENCE)
        await page.screenshot({
          caret: 'initial',
          path: `${process.env.HOME_LOADING_EVIDENCE}/1991-${colorScheme}-loaded.png`,
        });
    } finally {
      releaseScripts();
      releaseImages();
    }
  });

// A failed or disabled module must retain the readable server-rendered grid.
test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  for (const colorScheme of ['light', 'dark'] satisfies ('light' | 'dark')[])
    test(`homepage keeps its content-sized grid in ${colorScheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.route('**/demo/loading-*.svg', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#0647ff"/></svg>',
        }),
      );
      await page.goto('/');
      for (const width of [1991, 390, 601, 901, 1991]) {
        await page.setViewportSize({ width, height: 1138 });
        await assertNoOverlap(page);
      }
    });
});
