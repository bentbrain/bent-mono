import { test as sharedTest, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { startIsolatedBrowserServer } from '../fixtures/isolated-browser-server';
import { z } from 'zod';
import { settleMasonry } from '../fixtures/masonry-layout';
import { readFile, writeFile } from 'node:fs/promises';

// Keep file order while giving these fixtures their own CMS lifecycle.
let runtime: ReturnType<typeof startIsolatedBrowserServer> | undefined;
const test = sharedTest.extend<{ baseURL: string }>({
  baseURL: [
    async ({ browserName }, use, testInfo) => {
      runtime ??= startIsolatedBrowserServer(
        join(
          testInfo.project.outputDir,
          `grid-runtime-${browserName}-${String(testInfo.workerIndex)}.log`,
        ),
      );
      try {
        await use((await runtime.ready).baseURL);
      } catch (error) {
        await runtime.stop();
        throw error;
      }
    },
    { scope: 'test', timeout: 120_000 },
  ],
});

const run = crypto.randomUUID();
const postSchema = z.object({
  id: z.string(),
  day: z.string(),
  title: z.string(),
});
const posts: z.infer<typeof postSchema>[] = [];
const baseline: z.infer<typeof postSchema>[] = [];
const knownBaseline: z.infer<typeof postSchema>[] = [];
const baselineMedia: string[] = [];
const created = z.object({
  data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
});

function expectedPosts() {
  return [...baseline, ...posts].sort(
    (a, b) => b.day.localeCompare(a.day) || b.id.localeCompare(a.id),
  );
}

async function measure(page: Page) {
  return page.locator('.journal-grid').evaluate((grid) => {
    const rect = grid.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      map: (() => {
        const map = grid.querySelector('.journal-map-card');
        if (!map) throw new Error('Map required');
        const box = map.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      })(),
      footerTop: document.querySelector('footer')?.getBoundingClientRect().top,
      cards: Array.from(grid.querySelectorAll('article')).map((article) => {
        const card = article.querySelector('.journal-card-inner');
        if (!card) throw new Error('Card border required');
        const { x, y, width, height } = card.getBoundingClientRect();
        return {
          x,
          y,
          width,
          height,
          id: article.getAttribute('data-feedback-id')?.replace(/^post-/, ''),
          day: article.querySelector('time')?.getAttribute('datetime'),
          title: article.querySelector('h1')?.textContent.trim(),
        };
      }),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

async function earlierPage(page: Page) {
  return page.getByRole('link', { name: 'EARLIER →' }).getAttribute('href');
}

async function syntheticMedia(page: Page) {
  await page.route('**/demo/grid-baseline.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240"><rect width="160" height="240" fill="#0647ff"/><text x="8" y="120" fill="white">synthetic image</text></svg>',
    }),
  );
  await page.route('**/demo/grid-baseline.mp4', async (route) => {
    const body = await readFile(
      new URL('../fixtures/gallery-portrait.mp4', import.meta.url),
    );
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers()['range'] ?? '',
    );
    const startText = range?.[1];
    if (startText !== undefined) {
      const start = Number(startText);
      const end = Math.min(
        Number(range?.[2] || body.length - 1),
        body.length - 1,
      );
      if (start > end) {
        await route.fulfill({
          status: 416,
          headers: { 'Content-Range': `bytes */${String(body.length)}` },
        });
        return;
      }
      await route.fulfill({
        status: 206,
        contentType: 'video/mp4',
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${String(start)}-${String(end)}/${String(body.length)}`,
        },
        body: body.subarray(start, end + 1),
      });
      return;
    }
    await route.fulfill({
      contentType: 'video/mp4',
      headers: { 'Accept-Ranges': 'bytes' },
      body,
    });
  });
  await page.route(
    'https://shop.bent.build/api/configured-product-image/**',
    (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="white"/><text x="20" y="150" fill="#0647ff">synthetic shirt</text></svg>',
      }),
  );
}

async function assertBaselineMedia(page: Page) {
  const mixed = knownBaseline[0];
  if (!mixed) throw new Error('Known mixed-media baseline required');
  const card = page.locator(`article[data-feedback-id="post-${mixed.id}"]`);
  if (await card.count()) {
    await expect(card.locator('.post-media img')).toHaveCount(2);
    await expect(card.locator('video')).toHaveCount(1);
    await expect(card.locator('.post-design')).toHaveCount(1);
    await expect(card.locator('[data-feedback-id^="media-"]')).toHaveCount(2);
  }
}

test.beforeEach(async ({ page }) => {
  await syntheticMedia(page);
});

test.beforeAll(async ({ request, baseURL, browser }) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL };
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
  // Seed a known baseline before snapshotting. These duplicate titles and media
  // belong to this ephemeral CMS, independently of the later layout fixtures.
  for (const kind of ['photo', 'video']) {
    baselineMedia.push(
      await publish('media_items', `grid-baseline-${kind}`, {
        title: `Synthetic baseline ${kind}`,
        kind,
        captured_at: '2099-10-10T03:00:00Z',
        latitude: 35.6,
        longitude: 139.7,
        place: 'synthetic fixture',
        categories: [],
        demo: true,
        source_url: `/demo/grid-baseline.${kind === 'video' ? 'mp4' : 'svg'}`,
        poster_url: '/demo/grid-baseline.svg',
        ...(kind === 'video' ? { duration: 2 } : {}),
      }),
    );
  }
  for (const [index, day] of [
    '2099-10-10',
    '2099-10-09',
    '2099-10-08',
  ].entries()) {
    const title =
      index < 2 ? 'Synthetic duplicate baseline' : 'Synthetic earlier baseline';
    const id = await publish('posts', `grid-baseline-${String(index)}`, {
      title,
      day,
      demo: true,
      ...(index === 0
        ? {
            gallery: baselineMedia,
            shop_design: {
              productUrl:
                'https://shop.bent.build/featured/3d8ed467-55d4-45ed-ba9d-1eeb687fa5bc',
              color: 'white',
            },
          }
        : {}),
    });
    knownBaseline.push({ id, day, title });
  }
  // Measure the complete feed, including duplicate titles and earlier pages,
  // so every card contributes to chronology and final-row geometry.
  const page = await browser.newPage({ baseURL });
  try {
    await syntheticMedia(page);
    await page.route('**/toolbar.bent.build/**', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    let href: string | null = '/';
    const visited = new Set<string>();
    while (href) {
      expect(visited.has(href)).toBe(false);
      visited.add(href);
      await page.goto(href);
      baseline.push(...postSchema.array().parse((await measure(page)).cards));
      await assertBaselineMedia(page);
      if (await page.getByRole('link', { name: 'EARLIER →' }).count()) {
        href = await earlierPage(page);
        if (!href) throw new Error('Earlier page URL required');
      } else href = null;
    }
  } finally {
    await page.close();
  }
  expect(new Set(baseline.map((post) => post.id)).size).toBe(baseline.length);
  expect(baseline).toEqual(expect.arrayContaining(knownBaseline));
  expect(knownBaseline[0]?.title).toBe(knownBaseline[1]?.title);
  // Creation order differs from calendar order; equal days exercise ID ties.
  const fixtures = [
    { day: 12, paragraphs: 1 },
    { day: 17, paragraphs: 4 },
    { day: 13, paragraphs: 2 },
    { day: 16, paragraphs: 3 },
    { day: 15, paragraphs: 1 },
    { day: 17, paragraphs: 2 },
    { day: 14, paragraphs: 3 },
  ];
  // Include the whole baseline and leave one card in the final row at
  // both two and three columns. Twenty-four posts per page preserves this.
  const padding = (6 - (baseline.length % 6)) % 6;
  expect(padding).toBeGreaterThan(0);
  for (let extra = 0; extra < padding; extra++)
    fixtures.push({ day: 11, paragraphs: 2 });
  for (const [index, { day, paragraphs }] of fixtures.entries()) {
    const title = `Synthetic grid card ${String(index + 1)}`;
    const date = `2099-10-${String(day)}`;
    const response = await request.post('/_emdash/api/content/posts', {
      headers,
      data: {
        slug: `synthetic-grid-${String(index)}-${run}`,
        data: {
          title,
          day: date,
          demo: true,
          content: Array.from({ length: paragraphs }, (_, paragraph) => ({
            _type: 'block',
            _key: `paragraph-${String(paragraph)}`,
            style: 'normal',
            markDefs: [],
            children: [
              {
                _type: 'span',
                _key: 'text',
                marks: [],
                text: 'Synthetic card text for checking chronological rows and equal spacing with different amounts of content.',
              },
            ],
          })),
        },
      },
    });
    expect(response.ok()).toBe(true);
    const { item, _rev } = created.parse(await response.json()).data;
    posts.push({ id: item.id, day: date, title });
    expect(
      (
        await request.post(`/_emdash/api/content/posts/${item.id}/publish`, {
          headers,
          data: { _rev },
        })
      ).ok(),
    ).toBe(true);
  }
});

test.afterAll(async ({ request, baseURL }) => {
  await request.get('/_emdash/api/auth/dev-bypass');
  for (const { id } of [...posts, ...knownBaseline])
    expect(
      (
        await request.delete(`/_emdash/api/content/posts/${id}`, {
          headers: { 'X-EmDash-Request': '1', Origin: baseURL },
        })
      ).ok(),
    ).toBe(true);
  for (const id of baselineMedia)
    expect(
      (
        await request.delete(`/_emdash/api/content/media_items/${id}`, {
          headers: { 'X-EmDash-Request': '1', Origin: baseURL },
        })
      ).ok(),
    ).toBe(true);
});

for (const javaScriptEnabled of [true, false]) {
  test.describe(
    javaScriptEnabled ? 'loaded feed' : 'server-rendered feed',
    () => {
      test.use({ javaScriptEnabled });
      for (const colorScheme of ['light', 'dark'] satisfies (
        'light' | 'dark'
      )[])
        test(`chronological rows and equal visible gaps in ${colorScheme}`, async ({
          page,
        }) => {
          await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
          await page.route('**/toolbar.bent.build/**', (route) =>
            route.fulfill({ contentType: 'application/javascript', body: '' }),
          );
          const expected = expectedPosts();
          for (const width of [1991, 390, 601, 901, 1991]) {
            await page.setViewportSize({
              width,
              height: width === 390 ? 844 : 1138,
            });
            await page.goto('/');
            for (let offset = 0; offset < expected.length; offset += 24) {
              if (javaScriptEnabled)
                await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
              await page.evaluate(() => document.fonts.ready);
              await page.locator('article').first().scrollIntoViewIfNeeded();
              if (javaScriptEnabled)
                await settleMasonry(page.locator('.journal-grid'), 16);
              const metrics = await measure(page);
              await assertBaselineMedia(page);
              const evidence = process.env.FEED_GRID_EVIDENCE;
              if (evidence && [1991, 390].includes(width)) {
                const name = `${String(width)}-${colorScheme}-${javaScriptEnabled ? 'loaded' : 'no-js'}${offset ? `-page-${String(offset / 24 + 1)}` : ''}`;
                await page.screenshot({
                  path: `${evidence}/${name}.png`,
                  caret: 'initial',
                  fullPage: true,
                });
                await writeFile(
                  `${evidence}/${name}.json`,
                  JSON.stringify(metrics, null, 2),
                );
              }
              expect(postSchema.array().parse(metrics.cards)).toEqual(
                expected.slice(offset, offset + 24),
              );
              expect(metrics.overflow).toBe(0);
              const columns = width > 900 ? 3 : width > 600 ? 2 : 1;
              expect(metrics.map.x).toBeCloseTo(metrics.left, 1);
              expect(metrics.map.width).toBeCloseTo(
                metrics.right - metrics.left,
                1,
              );
              const columnWidth =
                (metrics.right - metrics.left - 16 * (columns - 1)) / columns;
              const first = metrics.cards[0];
              if (!first) throw new Error('Newest card required');
              expect(first.x).toBeCloseTo(metrics.left, 1);
              expect(
                first.y - metrics.map.y - metrics.map.height,
              ).toBeGreaterThanOrEqual(16);
              expect(first.y - metrics.map.y - metrics.map.height).toBeLessThan(
                17,
              );
              const occupiedColumns = new Set<number>();
              for (let index = 0; index < metrics.cards.length; index++) {
                const card = metrics.cards[index];
                if (!card) throw new Error('Card required');
                const column = Math.round(
                  (card.x - metrics.left) / (columnWidth + 16),
                );
                occupiedColumns.add(column);
                expect(card.width).toBeCloseTo(columnWidth, 1);
                expect(card.x).toBeCloseTo(
                  metrics.left + column * (columnWidth + 16),
                  1,
                );
                expect(card.y).toBeGreaterThanOrEqual(
                  metrics.map.y + metrics.map.height + 15,
                );
                const previous = metrics.cards[index - 1];
                if (previous) {
                  expect(
                    card.y > previous.y + 1 ||
                      (Math.abs(card.y - previous.y) <= 1 &&
                        card.x > previous.x),
                  ).toBe(true);
                }
                const above = metrics.cards
                  .slice(0, index)
                  .findLast((other) => Math.abs(other.x - card.x) < 1);
                if (above) {
                  const gap = card.y - above.y - above.height;
                  expect(gap).toBeGreaterThanOrEqual(16);
                  // The no-JS fallback has normal row-height gaps. Enhanced
                  // masonry packs each column to within one pixel of the gap.
                  if (javaScriptEnabled) expect(gap).toBeLessThan(17);
                }
                if (!javaScriptEnabled) expect(column).toBe(index % columns);
                for (const other of metrics.cards.slice(0, index)) {
                  const overlapWidth =
                    Math.min(card.x + card.width, other.x + other.width) -
                    Math.max(card.x, other.x);
                  const overlapHeight =
                    Math.min(card.y + card.height, other.y + other.height) -
                    Math.max(card.y, other.y);
                  expect(overlapWidth > 1 && overlapHeight > 1).toBe(false);
                }
                expect(card.x + card.width).toBeLessThanOrEqual(
                  metrics.right + 1,
                );
              }
              expect(occupiedColumns.size).toBe(columns);
              expect(
                new Set(metrics.cards.map((card) => Math.round(card.height)))
                  .size,
              ).toBeGreaterThan(1);
              if (metrics.footerTop === undefined)
                throw new Error('Footer required');
              expect(metrics.footerTop).toBeGreaterThan(
                Math.max(...metrics.cards.map((card) => card.y + card.height)),
              );
              if (offset + metrics.cards.length === expected.length) {
                // Include every baseline card, including the incomplete final group.
                expect(metrics.cards.length % 6).toBe(1);
                const final = metrics.cards.at(-1);
                if (!final) throw new Error('Final card required');
                // A single final item starts at the left in the row-major
                // no-JS fallback; enhanced packing follows actual row order.
                if (!javaScriptEnabled)
                  expect(final.x).toBeCloseTo(metrics.left, 1);
                await expect(
                  page.getByRole('link', { name: 'EARLIER →' }),
                ).toHaveCount(0);
              } else {
                const href = await earlierPage(page);
                if (!href) throw new Error('Earlier page URL required');
                await page.goto(href);
              }
            }
          }
        });
    },
  );
}

test('equal-day chronology stays stable across earlier pages', async ({
  page,
  request,
  baseURL,
}) => {
  await request.get('/_emdash/api/auth/dev-bypass');
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL };
  // Put a tied day across the 24-post boundary. Include every known baseline
  // post, checking identity as well as title so duplicate titles stay valid.
  for (let index = 0; index < 25; index++) {
    const title = `Synthetic pagination card ${String(index)}`;
    const response = await request.post('/_emdash/api/content/posts', {
      headers,
      data: {
        slug: `grid-page-${String(index)}-${run}`,
        data: { title, day: '2099-10-12', demo: true },
      },
    });
    expect(response.ok()).toBe(true);
    const { item, _rev } = created.parse(await response.json()).data;
    posts.push({ id: item.id, day: '2099-10-12', title });
    expect(
      (
        await request.post(`/_emdash/api/content/posts/${item.id}/publish`, {
          headers,
          data: { _rev },
        })
      ).ok(),
    ).toBe(true);
  }
  const expected = expectedPosts();
  const combined: z.infer<typeof postSchema>[] = [];
  const tiedPages = new Set<number>();
  await page.goto('/');
  for (let offset = 0; offset < expected.length; offset += 24) {
    await expect(page.locator('.journal-grid article h1')).toHaveText(
      expected.slice(offset, offset + 24).map((post) => post.title),
    );
    const rendered = postSchema.array().parse((await measure(page)).cards);
    combined.push(...rendered);
    if (rendered.some((post) => post.day === '2099-10-12'))
      tiedPages.add(offset / 24);
    if (combined.length === expected.length) break;
    const href = await earlierPage(page);
    if (!href) throw new Error('Earlier page URL required');
    await page.goto(href);
  }
  expect(tiedPages.size).toBeGreaterThan(1);
  expect(combined).toEqual(expected);
  expect(new Set(combined.map((post) => post.id)).size).toBe(expected.length);
  await expect(page.getByRole('link', { name: 'EARLIER →' })).toHaveCount(0);
});

test.afterAll(async () => {
  if (runtime) await runtime.stop();
  runtime = undefined;
});
