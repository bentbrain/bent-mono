import { test, expect, type Page } from '@playwright/test';
import { encode } from 'fast-png';
import { z } from 'zod';

function image(width: number, height: number) {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (x < 8 || y < 8 || Math.abs(x / width - y / height) < 0.035) {
        data[offset] = 6;
        data[offset + 1] = 71;
      }
    }
  return `data:image/png;base64,${Buffer.from(
    encode({ width, height, data, channels: 4, depth: 8 }),
  ).toString('base64')}`;
}
async function dimensions(page: Page) {
  return page.locator('#media-list button').evaluateAll((tiles) =>
    tiles.map((tile) => {
      const image = tile.querySelector('img');
      if (!image) throw new Error('Synthetic image missing');
      const box = image.getBoundingClientRect();
      return {
        height: tile.getBoundingClientRect().height,
        imageHeight: box.height,
        ratio: box.width / box.height,
        naturalRatio: image.naturalWidth / image.naturalHeight,
      };
    }),
  );
}
for (const width of [1792, 390])
  for (const colorScheme of ['light', 'dark'])
    test(`media tiles retain their image bounds through selection at ${String(width)}px ${colorScheme}`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await page.emulateMedia({
        colorScheme: colorScheme === 'light' ? 'light' : 'dark',
      });
      await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
      await page.waitForURL((url) => url.pathname === '/owner/media');
      const ids: string[] = [];
      for (const [title, source] of [
        ['synthetic portrait', image(240, 360)],
        ['synthetic landscape', image(360, 180)],
      ]) {
        const response = await page.request.post(
          '/_emdash/api/content/media_items',
          {
            headers: { Origin: baseURL || '', 'X-EmDash-Request': '1' },
            data: {
              slug: crypto.randomUUID(),
              data: {
                title,
                kind: 'photo',
                source_url: source,
                poster_url: source,
                captured_at: '2099-10-15T01:23:45.678Z',
                latitude: 35.6895,
                longitude: 139.6917,
                categories: [],
                place: 'synthetic fixture',
              },
            },
          },
        );
        expect(response.status()).toBe(201);
        ids.push(
          z
            .object({ data: z.object({ item: z.object({ id: z.string() }) }) })
            .parse(await response.json()).data.item.id,
        );
      }
      // Keep the rendered fixture small, independent of other browser fixtures.
      // The records and revision tokens still come from the native D1 API.
      await page.route('**/api/trip/media', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = z
          .object({ items: z.array(z.looseObject({ id: z.string() })) })
          .parse(await response.json());
        await route.fulfill({
          response,
          json: { items: body.items.filter((item) => ids.includes(item.id)) },
        });
      });
      await page.reload();
      await expect(page.locator('#media-list button')).toHaveCount(2);
      await page.locator('#media-list img').evaluateAll(async (images) => {
        await Promise.all(
          images.map((image) =>
            image instanceof HTMLImageElement
              ? image.decode()
              : Promise.reject(new Error('Image missing')),
          ),
        );
      });
      const closed = await dimensions(page);
      for (const title of ['synthetic portrait', 'synthetic landscape']) {
        const tile = page.getByRole('button', {
          name: `${title}, draft`,
          exact: true,
        });
        await tile.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByLabel('title', { exact: true })).toHaveValue(
          title,
        );
        const selected = await dimensions(page);
        selected.forEach((box, index) => {
          expect(box.height).toBeCloseTo(closed[index]?.height || 0, 0);
          expect(box.height).toBeCloseTo(box.imageHeight, 0);
          expect(box.ratio).toBeCloseTo(box.naturalRatio, 2);
        });
        await expect(page.locator('#metadata img')).toHaveCount(0);
        await expect(
          page.locator(
            'input[name="captured"],input[name="latitude"],input[name="longitude"]',
          ),
        ).toHaveCount(0);
        await expect(page.locator('#metadata time')).toHaveAttribute(
          'datetime',
          '2099-10-15T01:23:45.678Z',
        );
        await expect(page.locator('#metadata time')).toContainText(
          '10:23:45.678',
        );
        const panel = page.locator('#media-details');
        expect(
          await panel.evaluate(
            (element) => element.getBoundingClientRect().height,
          ),
        ).toBeLessThanOrEqual(640);
        await page.getByRole('button', { name: 'SAVE', exact: true }).focus();
        await expect(
          page.getByRole('button', { name: 'SAVE', exact: true }),
        ).toBeInViewport();
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    });

for (const width of [1280, 390])
  test(`missing metadata remains required and scrollable at ${String(width)}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
    await page.waitForURL((url) => url.pathname === '/owner/media');
    const title = `synthetic missing metadata ${crypto.randomUUID()}`;
    const created = await page.request.post(
      '/_emdash/api/content/media_items',
      {
        headers: { Origin: baseURL || '', 'X-EmDash-Request': '1' },
        data: {
          slug: crypto.randomUUID(),
          data: {
            title,
            kind: 'photo',
            latitude: 0,
            source_url: image(120, 180),
            categories: [],
          },
        },
      },
    );
    expect(created.status()).toBe(201);
    const id = z
      .object({ data: z.object({ item: z.object({ id: z.string() }) }) })
      .parse(await created.json()).data.item.id;
    await page.reload();
    await page
      .getByRole('button', { name: `${title}, draft`, exact: true })
      .click();
    await expect(page.getByLabel('latitude', { exact: true })).toHaveCount(0);
    const captured = page.getByLabel('captured in japan');
    const longitude = page.getByLabel('longitude', { exact: true });
    await expect(captured).toHaveValue('');
    await expect(longitude).toHaveValue('');
    let saves = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'PATCH' &&
        request.url().endsWith('/api/trip/media')
      )
        saves++;
    });
    const panel = page.locator('#media-details');
    expect(
      await panel.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(440);
    expect(
      await panel.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'SAVE', exact: true }).click();
    expect(saves).toBe(0);
    await expect(captured).toBeFocused();
    await captured.fill('2099-10-15T10:23:45.678');
    await longitude.fill('139.6917');
    // Selecting a point may fill only missing coordinates, preserving latitude 0.
    await page.locator('#pin-picker').click();
    await longitude.fill('139.6917');
    await page.getByRole('button', { name: 'SAVE', exact: true }).focus();
    await expect(
      page.getByRole('button', { name: 'SAVE', exact: true }),
    ).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('#save-status')).toHaveText('saved');
    expect(saves).toBe(1);
    const response = await page.request.get(
      `/_emdash/api/content/media_items/${id}`,
    );
    const data = z
      .object({
        data: z.object({
          item: z.object({
            data: z.object({
              latitude: z.number(),
              longitude: z.number(),
              captured_at: z.string(),
            }),
          }),
        }),
      })
      .parse(await response.json()).data.item.data;
    expect(data).toEqual({
      latitude: 0,
      longitude: 139.6917,
      captured_at: '2099-10-15T01:23:45.678Z',
    });
    await expect(
      page.locator(
        '#metadata input[name="captured"],#metadata input[name="longitude"]',
      ),
    ).toHaveCount(0);
    await expect(page.locator('#metadata time')).toHaveAttribute(
      'datetime',
      data.captured_at,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
