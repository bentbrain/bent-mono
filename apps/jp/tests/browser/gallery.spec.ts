import { test, expect } from '@playwright/test';
import { z } from 'zod';

const iconCategories = [
  'landscape',
  'food',
  'shopping',
  'beer',
  'people',
  'origami',
];

test.beforeAll(async ({ request, baseURL }) => {
  const setup = await request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
    data: {},
  });
  expect(setup.ok()).toBe(true);
  await request.get('/_emdash/api/auth/dev-bypass');
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  const listed = await request.get(
    '/_emdash/api/content/media_items?limit=100',
  );
  const existing = z
    .object({
      data: z.object({
        items: z.array(
          z.object({ id: z.string(), slug: z.string().nullable() }),
        ),
      }),
    })
    .parse(await listed.json())
    .data.items.find((item) => item.slug === 'gallery-alignment-fixture');
  let id = existing?.id;
  if (!id) {
    const created = await request.post('/_emdash/api/content/media_items', {
      headers,
      data: {
        slug: 'gallery-alignment-fixture',
        data: {
          title: 'Synthetic gallery alignment fixture',
          kind: 'photo',
          captured_at: '2099-10-15T12:00:00+09:00',
          latitude: 35.6895,
          longitude: 139.6917,
          place: 'synthetic fixture',
          categories: iconCategories,
          source_url: '/demo/japan.jpg',
          demo: true,
        },
      },
    });
    expect(created.ok()).toBe(true);
    id = z
      .object({ data: z.object({ item: z.object({ id: z.string() }) }) })
      .parse(await created.json()).data.item.id;
  }
  const current = await request.get(`/_emdash/api/content/media_items/${id}`);
  const revision = z
    .object({ data: z.object({ _rev: z.string() }) })
    .parse(await current.json()).data._rev;
  const published = await request.post(
    `/_emdash/api/content/media_items/${id}/publish`,
    { headers, data: { _rev: revision } },
  );
  expect(published.ok()).toBe(true);
});

for (const width of [390, 1778]) {
  for (const textScale of [1, 2]) {
    for (const colorScheme of ['light', 'dark']) {
      test(`gallery raster paint centers on text at ${String(width)}px, ${String(textScale * 100)}% text, ${colorScheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 1024 });
        await page.emulateMedia({
          colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
        });
        await page.route('https://toolbar.bent.build/embed.js', (route) =>
          route.fulfill({ contentType: 'application/javascript', body: '' }),
        );
        for (const selected of ['all', 'landscape']) {
          await page.goto(`/gallery?category=${selected}`);
          await page
            .locator('[data-feedback-id="gallery-filters"] a')
            .evaluateAll((links, scale) => {
              for (const link of links) {
                if (link instanceof HTMLElement)
                  link.style.fontSize = `${String(13 * scale)}px`;
              }
            }, textScale);
          await page.evaluate(() => document.fonts.ready);
          const filters = page.locator('[data-feedback-id="gallery-filters"]');
          await expect(filters.locator('a').nth(1)).toHaveText('landscape');
          for (const link of await filters.locator('a').all())
            await expect(link).toHaveCSS(
              'font-size',
              `${String(13 * textScale)}px`,
            );
          if (process.env.GALLERY_EVIDENCE && selected === 'all') {
            await page.screenshot({
              path: `${process.env.GALLERY_EVIDENCE}/gallery-${String(width)}-${String(textScale)}-${colorScheme}.png`,
              clip: { x: 0, y: 0, width, height: width === 390 ? 340 : 180 },
            });
          }
          for (const name of iconCategories) {
            const link = filters.getByRole('link', { name, exact: true });
            await expect(link.locator('[data-builtin-icon]')).toHaveAttribute(
              'data-builtin-icon',
              name,
            );
            await expect(link.locator('svg')).toHaveCount(0);
            const metrics = await link.evaluate(async (anchor) => {
              const mask = anchor.querySelector('[data-generated-icon]');
              const text = [...anchor.childNodes].find(
                (node) =>
                  node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
              );
              if (!(mask instanceof HTMLElement) || !text)
                throw new Error('Rendered raster and category text required');
              const style = getComputedStyle(mask);
              const url = style.maskImage.match(/^url\("(.+)"\)$/)?.[1];
              if (!url) throw new Error('PNG mask URL required');
              const image = new Image();
              image.src = url;
              await image.decode();
              const canvas = document.createElement('canvas');
              canvas.width = image.naturalWidth;
              canvas.height = image.naturalHeight;
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Raster context required');
              context.drawImage(image, 0, 0);
              const pixels = context.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
              ).data;
              let first = canvas.height;
              let last = -1;
              for (let y = 0; y < canvas.height; y++)
                for (let x = 0; x < canvas.width; x++)
                  if ((pixels[(y * canvas.width + x) * 4 + 3] ?? 0) > 0) {
                    first = Math.min(first, y);
                    last = Math.max(last, y);
                  }
              if (last < first)
                throw new Error('Visible raster paint required');
              const box = mask.getBoundingClientRect();
              const top = box.y + (first / canvas.height) * box.height;
              const bottom = box.y + ((last + 1) / canvas.height) * box.height;
              const range = document.createRange();
              range.selectNodeContents(text);
              const line = range.getBoundingClientRect();
              return {
                maskUrl: url,
                color: style.backgroundColor,
                sourceWidth: canvas.width,
                paintCenter: (top + bottom) / 2,
                textCenter: (line.top + line.bottom) / 2,
                top,
                bottom,
                boxTop: box.top,
                boxBottom: box.bottom,
                iconSize: box.width,
                fontSize: parseFloat(getComputedStyle(anchor).fontSize),
              };
            });
            expect(metrics.maskUrl).toContain(`/category-icons/${name}-v1.png`);
            expect(metrics.sourceWidth).toBe(32);
            expect(metrics.color).toBe(
              selected === name
                ? colorScheme === 'dark'
                  ? 'rgb(0, 0, 0)'
                  : 'rgb(255, 255, 255)'
                : colorScheme === 'dark'
                  ? 'rgb(40, 112, 255)'
                  : 'rgb(6, 71, 255)',
            );
            expect
              .soft(
                Math.abs(metrics.paintCenter - metrics.textCenter),
                `${name}: ${JSON.stringify(metrics)}`,
              )
              .toBeLessThanOrEqual(0.75);
            expect
              .soft(metrics.top, name)
              .toBeGreaterThanOrEqual(metrics.boxTop);
            expect
              .soft(metrics.bottom, name)
              .toBeLessThanOrEqual(metrics.boxBottom);
            expect
              .soft(metrics.iconSize, name)
              .toBeCloseTo(1.7 * metrics.fontSize, 1);
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(width);
        }
      });
    }
  }
}

test('category links update the query and results without replacing the document', async ({
  page,
}) => {
  await page.goto('/gallery?category=missing&keep=1');
  await expect(page.getByText('no photos yet', { exact: true })).toBeVisible();
  let documentRequests = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documentRequests++;
  });
  const filters = page.getByRole('navigation', { name: 'Media categories' });
  await filters.getByRole('link', { name: 'food', exact: true }).click();
  await expect(page).toHaveURL(/category=food/);
  await expect(
    page.getByRole('img', { name: 'Synthetic gallery alignment fixture' }),
  ).toBeVisible();
  await expect(
    filters.getByRole('link', { name: 'food', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page.getByText('no photos yet', { exact: true })).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole('img', { name: 'Synthetic gallery alignment fixture' }),
  ).toBeVisible();
  await filters.getByRole('link', { name: 'all', exact: true }).click();
  expect(new URL(page.url()).searchParams.has('category')).toBe(false);
  expect(documentRequests).toBe(0);
  expect(new URL(page.url()).searchParams.get('keep')).toBe('1');
});

for (const route of [
  '/',
  '/gallery',
  '/media/gallery-alignment-fixture',
  '/newsletter/privacy',
]) {
  test(`shared header stays visible after scrolling ${route}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto(route);
    await page.evaluate(() => {
      window.scrollTo(0, 500);
    });
    const header = page.getByRole('banner');
    await expect(header).toHaveCSS('position', 'sticky');
    expect((await header.boundingBox())?.y).toBe(0);
  });
}

test('direct category links still filter when JavaScript is disabled', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    await page.goto('/gallery?category=missing');
    await expect(
      page.getByText('no photos yet', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Media categories' })
      .getByRole('link', { name: 'food', exact: true })
      .click();
    await expect(
      page.getByRole('img', { name: 'Synthetic gallery alignment fixture' }),
    ).toBeVisible();
    await expect(page.getByText('no photos yet', { exact: true })).toBeHidden();
  } finally {
    await context.close();
  }
});
