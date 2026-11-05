import { test, expect } from '@playwright/test';
import { z } from 'zod';

const fixtures: string[] = [];
const saved = z.object({
  data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
});

test.beforeAll(async ({ browser, request, baseURL }) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  expect(
    (
      await request.post('/_emdash/api/setup/dev-bypass', { headers, data: {} })
    ).ok(),
  ).toBe(true);
  await request.get('/_emdash/api/auth/dev-bypass');
  const page = await browser.newPage();
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto(`${baseURL || ''}/`);
  try {
    for (let index = 0; index < 6; index++) {
      const jpeg = await page.evaluate((index) => {
        const canvas = document.createElement('canvas');
        canvas.width = 600;
        canvas.height = 800;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas required');
        context.fillStyle = `hsl(${String(index * 50)} 75% 60%)`;
        context.fillRect(0, 0, 600, 800);
        context.fillStyle = '#0647ff';
        context.font = '32px monospace';
        context.fillText(`synthetic photo ${String(index)}`, 35, 120);
        return canvas.toDataURL('image/jpeg').split(',')[1] || '';
      }, index);
      const file = {
        name: 'synthetic.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from(jpeg, 'base64'),
      };
      const upload = await request.post('/api/trip/upload', {
        headers,
        multipart: { original: file, display: file, poster: file },
      });
      expect(upload.status()).toBe(201);
      const id = saved.parse(await upload.json()).data.item.id;
      fixtures.push(id);
      const current = saved.parse(
        await (
          await request.get(`/_emdash/api/content/media_items/${id}`)
        ).json(),
      ).data;
      expect(
        (
          await request.put(`/_emdash/api/content/media_items/${id}`, {
            headers,
            data: {
              _rev: current._rev,
              data: {
                title: `Synthetic preload ${String(index)}`,
                captured_at: `2098-10-15T00:00:0${String(index)}Z`,
                latitude: 26.5,
                longitude: 127.9,
                place: 'synthetic preload fixture',
                categories: [],
                demo: true,
              },
            },
          })
        ).ok(),
      ).toBe(true);
      const updated = saved.parse(
        await (
          await request.get(`/_emdash/api/content/media_items/${id}`)
        ).json(),
      ).data;
      expect(
        (
          await request.post(`/_emdash/api/content/media_items/${id}/publish`, {
            headers,
            data: { _rev: updated._rev },
          })
        ).ok(),
      ).toBe(true);
    }
  } finally {
    await page.close();
  }
});

test.afterAll(async ({ request, baseURL }) => {
  await request.get('/_emdash/api/auth/dev-bypass');
  for (const id of fixtures)
    expect(
      (
        await request.delete(`/_emdash/api/content/media_items/${id}`, {
          headers: { 'X-EmDash-Request': '1', Origin: baseURL || '' },
        })
      ).ok(),
    ).toBe(true);
});

for (const width of [390, 1991]) {
  test(`map gallery preloads only adjacent photos and reuses them at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.route('https://toolbar.bent.build/embed.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    const lookups: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/map-photo/')) lookups.push(request.url());
    });
    await page.goto(`/?media=${fixtures[0] || ''}#japan-map`);
    const popup = page.locator('[data-feedback-id="map-preview"]');
    const active = popup.locator('[data-map-photo="active"] img');
    await expect(active).toBeVisible();
    await expect(popup.locator('img')).toHaveCount(3);
    await expect
      .poll(() =>
        popup
          .locator('img')
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement &&
                image.complete &&
                image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    expect(lookups).toHaveLength(3);
    const initial = await active.getAttribute('alt');
    const target = popup.locator('[data-map-photo="preload"] img').last();
    const targetAlt = await target.getAttribute('alt');
    await target.evaluate((image) => {
      image.setAttribute('data-reuse-proof', 'yes');
    });
    // Find which adjacent direction owns the marked photo, including wraparound.
    const order = await popup
      .locator('[data-map-photo] img')
      .evaluateAll((images) =>
        images.map((image) => image.getAttribute('alt')),
      );
    expect(order).toHaveLength(3);
    const next = popup.getByRole('button', {
      name: 'Next media at this location',
    });
    const previous = popup.getByRole('button', {
      name: 'Previous media at this location',
    });
    // The records are capture-time sorted descending. fixtures[0] is the last.
    await previous.scrollIntoViewIfNeeded();
    const before = await popup.boundingBox();
    await previous.click();
    await expect(active).toHaveAttribute('alt', targetAlt || '');
    await expect(active).toHaveAttribute('data-reuse-proof', 'yes');
    expect(
      await active.evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    ).toBe(true);
    expect(await popup.boundingBox()).toEqual(before);
    await next.click();
    await expect(active).toHaveAttribute('alt', initial || '');
    expect(
      await active.evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    ).toBe(true);
    await expect(popup.locator('img')).toHaveCount(3);
    // Advancing the window can fetch one new neighbor, never the whole group.
    expect(new Set(lookups).size).toBeLessThanOrEqual(4);
    await next.click();
    await expect(active).toHaveAttribute('alt', 'Synthetic preload 5');
    expect(
      await active.evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    ).toBe(true);
    await previous.click();
    await expect(active).toHaveAttribute('alt', initial || '');
    await expect(popup.locator('img')).toHaveCount(3);
    expect(new Set(lookups).size).toBeLessThan(6);
    if (process.env.MAP_PRELOAD_EVIDENCE_DIR)
      await popup.screenshot({
        path: `${process.env.MAP_PRELOAD_EVIDENCE_DIR}/${String(width)}-navigation.png`,
      });
    await popup.getByRole('button', { name: 'Close map preview' }).click();
    await expect(popup).toHaveCount(0);
    await expect(page.locator('[data-map-photo]')).toHaveCount(0);
  });
}
