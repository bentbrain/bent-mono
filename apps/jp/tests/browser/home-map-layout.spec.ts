import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { settleMasonry } from '../fixtures/masonry-layout';

const fixtureRun = crypto.randomUUID();
const posts: { id: string; day: string }[] = [];
const createdSchema = z.object({
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
  // Create out of chronological order so insertion order cannot hide a sort regression.
  for (const day of ['2098-10-13', '2098-10-15', '2098-10-14', '2098-10-12']) {
    const response = await request.post('/_emdash/api/content/posts', {
      headers,
      data: {
        slug: `synthetic-map-layout-${day}-${fixtureRun}`,
        data: {
          title: `Synthetic layout post ${day}`,
          day,
          demo: true,
          content: Array.from(
            { length: Number(day.slice(-2)) - 12 },
            (_, index) => ({
              _type: 'block',
              _key: `synthetic-${String(index)}`,
              style: 'normal',
              markDefs: [],
              children: [
                {
                  _type: 'span',
                  _key: `text-${String(index)}`,
                  text: 'Synthetic content with different post heights for visual reading order.',
                  marks: [],
                },
              ],
            }),
          ),
          gallery: [],
        },
      },
    });
    expect(response.ok()).toBe(true);
    const { item, _rev } = createdSchema.parse(await response.json()).data;
    posts.push({ id: item.id, day });
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
  for (const post of posts)
    expect(
      (
        await request.delete(`/_emdash/api/content/posts/${post.id}`, {
          headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
        })
      ).ok(),
    ).toBe(true);
});

for (const scheme of ['light', 'dark'] satisfies ('light' | 'dark')[]) {
  test(`home map spans the feed and newest post starts left in ${scheme}`, async ({
    page,
  }) => {
    await page.route('https://toolbar.bent.build/embed.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'SUBSCRIBE', exact: true }),
    ).toBeEnabled();
    const grid = page.locator('.journal-grid');
    const map = grid.locator('.journal-map-card');
    const articles = grid.locator(':scope > article');
    const expected = posts.toSorted((a, b) => b.day.localeCompare(a.day));
    await expect(articles.first().locator('time')).toHaveAttribute(
      'datetime',
      expected[0]?.day ?? '',
    );
    for (const width of [390, 601, 1991, 1280, 901, 900, 600, 390, 1991]) {
      await page.setViewportSize({ width, height: 1138 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        // Let responsive map rendering settle after crossing a breakpoint.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          }),
        );
      });
      await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
      if (process.env.HOME_MAP_EVIDENCE && [390, 1991].includes(width))
        await page.screenshot({
          path: `${process.env.HOME_MAP_EVIDENCE}/${String(width)}-${scheme}.png`,
        });
      await settleMasonry(grid, 16);
      const gridBox = await grid.boundingBox();
      const mapBox = await map.boundingBox();
      if (!gridBox || !mapBox)
        throw new Error('Home grid and map bounds required');
      expect(mapBox.x).toBeCloseTo(gridBox.x, 0);
      expect(mapBox.width).toBeCloseTo(gridBox.width, 0);
      const boxes = [];
      for (const post of expected) {
        const article = grid.locator(`[data-feedback-id="post-${post.id}"]`);
        await expect(article.locator('time')).toHaveAttribute(
          'datetime',
          post.day,
        );
        const box = await article.boundingBox();
        if (!box) throw new Error('Synthetic post bounds required');
        expect(box.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height);
        boxes.push(box);
      }
      const first = boxes[0];
      if (!first) throw new Error('Newest post required');
      expect(first.x).toBeCloseTo(gridBox.x, 0);
      expect(first.y - mapBox.y - mapBox.height).toBeCloseTo(16, 0);
      // Compare displayed positions, so chronological DOM order alone cannot pass.
      for (let index = 1; index < boxes.length; index++) {
        const previous = boxes[index - 1];
        const current = boxes[index];
        if (!previous || !current) throw new Error('Post sequence required');
        expect(
          current.y > previous.y + 1 ||
            (Math.abs(current.y - previous.y) <= 1 && current.x > previous.x),
        ).toBe(true);
        const above = boxes
          .slice(0, index)
          .filter((other) => Math.abs(other.x - current.x) < 1);
        const priorBottom = above.length
          ? Math.max(...above.map((other) => other.y + other.height))
          : mapBox.y + mapBox.height;
        expect(current.y - priorBottom).toBeGreaterThanOrEqual(16);
        expect(current.y - priorBottom).toBeLessThan(17);
      }
      expect(
        await articles
          .locator('time')
          .evaluateAll((times) =>
            times.slice(0, 4).map((time) => time.getAttribute('datetime')),
          ),
      ).toEqual(expected.map((post) => post.day));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    }
  });
}
