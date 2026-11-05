import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encode, decode } from 'fast-png';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

function photoBounds(png: Uint8Array) {
  const { width, height, data, channels } = decode(png);
  let left = width,
    right = 0,
    top = height,
    bottom = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      if ((data[offset] || 0) > 200 && (data[offset + 1] || 0) < 80) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  return { width: right - left + 1, height: bottom - top + 1 };
}

async function openSampleExport(page: Page) {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/export');
  await page.waitForURL('**/owner/export');
  await expect(page.getByRole('button', { name: 'EXPORT PNG' })).toBeEnabled();
  const day = page.getByRole('combobox', { name: 'day', exact: true });
  if ((await day.innerText()).trim() !== '2026-10-15') {
    const changed = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/trip/story') || !response.ok())
        return false;
      const body = z
        .object({ day: z.string() })
        .safeParse(response.request().postDataJSON());
      return body.success && body.data.day === '2026-10-15';
    });
    await day.click();
    await page.getByRole('option', { name: '2026-10-15', exact: true }).click();
    await changed;
  }
  // The previous day's enabled export button can survive until React's next
  // effect. Wait for the selected day's response before measuring drag bounds.
  await expect(page.getByRole('button', { name: 'EXPORT PNG' })).toBeEnabled();
}

test.beforeAll(async ({ request, baseURL }) => {
  const setup = await request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL || '' },
    data: {},
  });
  expect(setup.ok()).toBe(true);
  await promisify(execFile)('bun', ['demo'], {
    env: { ...process.env, TEST_BASE_URL: baseURL },
  });
});

test.beforeEach(async ({ page }) => {
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  // Exercise portrait and landscape images through the published sample records.
  await page.route('**/demo/*.jpg', (route) => {
    const portrait = route.request().url().endsWith('/tokyo.jpg');
    const width = portrait ? 120 : 240;
    const height = portrait ? 180 : 120;
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        encode({
          width,
          height,
          data: Uint8Array.from(
            { length: width * height * 4 },
            (_, index) => [240, 40, 40, 255][index % 4] || 0,
          ),
          channels: 4,
          depth: 8,
        }),
      ),
    });
  });
});

for (const width of [390, 1280]) {
  for (const path of ['/', '/posts/tokyo-after-dark', '/gallery']) {
    test(`published photos retain their full proportions on ${path} at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(path);
      await expect(
        page.locator('astro-island[component-export="PostMedia"][ssr]'),
      ).toHaveCount(0);
      if (path === '/') {
        for (const card of await page.locator('article').all()) {
          const slides = card.locator('[data-slot="carousel-item"]');
          for (let index = 0; index < (await slides.count()); index++) {
            const photo = slides.nth(index).locator('.media-tile img');
            if (await photo.count()) {
              await photo.scrollIntoViewIfNeeded();
              await expect(slides.nth(index)).toBeInViewport({ ratio: 0.99 });
              await photo.evaluate(async (image) => {
                if (image instanceof HTMLImageElement) {
                  image.loading = 'eager';
                  await image.decode();
                }
              });
              const natural = await photo.evaluate((image) =>
                image instanceof HTMLImageElement
                  ? image.naturalWidth / image.naturalHeight
                  : 0,
              );
              const paint = photoBounds(
                await photo.screenshot({ caret: 'initial' }),
              );
              expect(paint.width / paint.height).toBeCloseTo(natural, 2);
            }
            if (index < (await slides.count()) - 1)
              await card.getByRole('button', { name: 'Next slide' }).click();
          }
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        return;
      }
      const images = page.locator('.media-tile img');
      expect(await images.count()).toBeGreaterThan(1);
      const ratios = await images.evaluateAll(async (images) =>
        Promise.all(
          images.map(async (image) => {
            if (!(image instanceof HTMLImageElement))
              throw new Error('Photo required');
            image.loading = 'eager';
            await image.decode();
            const box = image.getBoundingClientRect();
            const tile = image.parentElement?.getBoundingClientRect();
            if (!tile) throw new Error('Media tile required');
            return {
              actual: box.width / box.height,
              natural: image.naturalWidth / image.naturalHeight,
              tileHeight: tile.height,
              imageHeight: box.height,
            };
          }),
        ),
      );
      for (const [index, ratio] of ratios.entries()) {
        if (path === '/gallery') {
          expect(ratio.actual).toBeCloseTo(ratio.natural, 2);
          expect(ratio.tileHeight).toBeCloseTo(ratio.imageHeight, 0);
        } else {
          const paint = photoBounds(
            await images.nth(index).screenshot({ caret: 'initial' }),
          );
          // Raster edges round independently when a grid slot is fractional.
          expect(
            Math.abs(paint.width - paint.height * ratio.natural),
          ).toBeLessThanOrEqual(2);
        }
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    });
  }

  test(`post mosaic exposes every photo and video without carousel controls at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/posts/tokyo-after-dark');
    const mosaic = page.getByRole('region', {
      name: 'tokyo media',
      exact: true,
    });
    await expect(mosaic.locator('.media-tile')).toHaveCount(3);
    await expect(mosaic.locator('img')).toHaveCount(2);
    await expect(mosaic.locator('video[controls]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Next slide' })).toHaveCount(
      0,
    );
    for (const tile of await mosaic.locator('.media-tile').all()) {
      await tile.scrollIntoViewIfNeeded();
      await expect(tile).toBeInViewport();
    }
  });
}

test('post layout responds to its container without changing the viewport', async ({
  page,
}) => {
  await page.goto('/posts/tokyo-after-dark');
  const article = page.locator('.single-post');
  const heading = article.locator('.post-heading');
  const tiles = article.locator('.post-mosaic .media-tile');
  await expect(tiles).toHaveCount(3);
  await expect(heading).toHaveCSS('flex-direction', 'row');
  const wide = await tiles.nth(1).boundingBox();
  const articleBox = await article.boundingBox();
  if (!wide || !articleBox) throw new Error('Post media bounds required');
  expect(wide.width).toBeCloseTo((articleBox.width - 7) / 2, 0);
  await article.evaluate((element) => {
    element.style.width = '320px';
  });
  await expect(heading).toHaveCSS('flex-direction', 'column');
  const narrow = await tiles.nth(1).boundingBox();
  if (!narrow) throw new Error('Narrow post media required');
  expect(narrow.width).toBeCloseTo(320, 0);
});

for (const { title, ratio, shape } of [
  { title: 'tokyo / 7', ratio: 2 / 3, shape: 'portrait' },
  { title: 'tokyo / 8', ratio: 2, shape: 'landscape' },
]) {
  for (const angle of ['no skew', 'right edge up']) {
    test(`story preview and PNG retain ${shape} proportions with ${angle}`, async ({
      page,
    }, info) => {
      await openSampleExport(page);
      const selection = page.locator('#export-selection');
      while (await selection.getByRole('checkbox', { checked: true }).count())
        await selection
          .getByRole('checkbox', { checked: true })
          .first()
          .uncheck();
      await selection
        .locator('.select-media')
        .filter({
          has: page.getByRole('img', { name: title, exact: true }),
        })
        .getByRole('checkbox')
        .check();
      await page.getByRole('combobox', { name: 'card angle' }).click();
      await page.getByRole('option', { name: angle, exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'EXPORT PNG' }),
      ).toBeEnabled();
      const preview = await page
        .locator('#story-preview canvas')
        .evaluate((canvas) => {
          if (!(canvas instanceof HTMLCanvasElement))
            throw new Error('Preview required');
          return canvas.toDataURL('image/png').split(',')[1] || '';
        });
      await page.locator('[data-feedback-id="story-composition"]').screenshot({
        path: info.outputPath('preview.png'),
      });
      const bounds = photoBounds(Buffer.from(preview, 'base64'));
      if (angle === 'no skew')
        expect(
          Math.abs(bounds.width - bounds.height * ratio),
        ).toBeLessThanOrEqual(3);
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'EXPORT PNG' }).click();
      const file = await download;
      const path = info.outputPath('proportions.png');
      await file.saveAs(path);
      const previewBytes = Buffer.from(preview, 'base64');
      const exportedBytes = await readFile(path);
      const exported = photoBounds(exportedBytes);
      if (angle === 'no skew')
        expect(
          Math.abs(exported.width - exported.height * ratio),
        ).toBeLessThanOrEqual(3);
      expect(
        Buffer.compare(
          Buffer.from(decode(exportedBytes).data),
          Buffer.from(decode(previewBytes).data),
        ),
      ).toBe(0);
      for (const bytes of [previewBytes, exportedBytes]) {
        const { width, data } = decode(bytes);
        // This row crosses both photo edges, away from the title and counter.
        const white = Array.from({ length: width }, (_, x) => {
          const offset = (850 * width + x) * 4;
          return (
            (data[offset] || 0) > 200 &&
            (data[offset + 1] || 0) > 200 &&
            (data[offset + 2] || 0) > 200
          );
        }).filter(Boolean).length;
        expect(white).toBeGreaterThanOrEqual(2);
        expect(white).toBeLessThanOrEqual(4);
      }
    });
  }
}

for (const width of [390, 1280]) {
  test(`stack order reaches the renderer at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await openSampleExport(page);
    const tiles = page.locator('#export-selection .select-media');
    const original = await tiles.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-media-id')),
    );
    expect(original.length).toBeGreaterThan(1);
    await expect(
      tiles.first().getByRole('button', { name: /toward back/ }),
    ).toBeDisabled();
    await expect(
      tiles.last().getByRole('button', { name: /toward front/ }),
    ).toBeDisabled();
    const response = page.waitForResponse(
      (response) => response.url().endsWith('/api/trip/story') && response.ok(),
    );
    const move = tiles.first().getByRole('button', { name: /toward front/ });
    await move.focus();
    await move.press('Enter');
    const manifest = z
      .object({ media: z.array(z.object({ id: z.string() })) })
      .parse(await (await response).json());
    const expected = [original[1], original[0], ...original.slice(2)];
    expect(manifest.media.map((item) => item.id)).toEqual(expected);
    expect(
      await tiles.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-media-id')),
      ),
    ).toEqual(expected);
    await expect(
      page.getByRole('button', { name: 'EXPORT PNG' }),
    ).toBeEnabled();
    await expect(tiles.nth(1).getByLabel(/Stack position 2 of/)).toBeVisible();
    await tiles.nth(1).getByRole('checkbox').uncheck();
    await expect(tiles.last().getByRole('button')).toHaveCount(0);
    await tiles.last().getByRole('checkbox').check();
    await expect(
      tiles
        .last()
        .getByLabel(
          `Stack position ${String(original.length)} of ${String(original.length)}`,
        ),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  });
}

test('story day numbering starts with the first photo capture day, not earlier posts or beers', async ({
  page,
  baseURL,
}) => {
  await openSampleExport(page);
  // Other browser files can publish uploads. Give this test its own real capture
  // anchor so older sample photos do not define the production trip timeline.
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  const file = {
    name: 'synthetic-day-anchor.jpg',
    mimeType: 'image/jpeg',
    buffer: await readFile('public/demo/japan.jpg'),
  };
  const created = await page.request.post('/api/trip/upload', {
    headers,
    multipart: { original: file, display: file, poster: file },
  });
  expect(created.status()).toBe(201);
  const { item, _rev } = z
    .object({
      data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
    })
    .parse(await created.json()).data;
  try {
    const published = await page.request.patch('/api/trip/media', {
      headers,
      data: {
        id: item.id,
        revision: _rev,
        publish: true,
        metadata: {
          title: 'Synthetic day numbering anchor',
          captured_at: '2026-10-14T15:00:00+09:00',
          latitude: 35.68,
          longitude: 139.76,
          place: 'synthetic',
          categories: [],
        },
      },
    });
    expect(published.status(), await published.text()).toBe(200);
    const response = page.waitForResponse(
      (response) => response.url().endsWith('/api/trip/story') && response.ok(),
    );
    await page.getByRole('combobox', { name: 'day', exact: true }).click();
    await page.getByRole('option', { name: '2026-10-14', exact: true }).click();
    const manifest = z
      .object({ day: z.string(), title: z.string() })
      .parse(await (await response).json());
    expect(manifest.day).toBe('2026-10-14');
    expect(manifest.title).toBe('day 1: kyoto');
    await expect(
      page.getByRole('button', { name: 'EXPORT PNG' }),
    ).toBeEnabled();
    const nextResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/trip/story') && response.ok(),
    );
    await page.clock.setFixedTime(new Date('2030-01-01T12:00:00Z'));
    await page.getByRole('combobox', { name: 'day', exact: true }).click();
    await page.getByRole('option', { name: '2026-10-15', exact: true }).click();
    const next = z
      .object({ day: z.string(), title: z.string() })
      .parse(await (await nextResponse).json());
    expect(next.day).toBe('2026-10-15');
    expect(next.title).toMatch(/^day 2: /);
  } finally {
    expect(
      (
        await page.request.delete(
          `/_emdash/api/content/media_items/${item.id}`,
          {
            headers,
          },
        )
      ).ok(),
    ).toBe(true);
  }
});

for (const width of [390, 1280]) {
  test(`dragging reorders the export stack at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await openSampleExport(page);
    const tiles = page.locator('#export-selection .select-media');
    const original = await tiles.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-media-id')),
    );
    const handle = tiles.first().getByRole('button', { name: /^Drag / });
    await handle.scrollIntoViewIfNeeded();
    const source = await handle.boundingBox();
    const target = await tiles.nth(2).boundingBox();
    if (!source || !target) throw new Error('Drag bounds required');
    const from = {
      x: source.x + source.width / 2,
      y: source.y + source.height / 2,
    };
    const to = { x: target.x + target.width / 2, y: target.y + 30 };
    const response = page.waitForResponse(
      (response) => response.url().endsWith('/api/trip/story') && response.ok(),
    );
    if (width === 390) {
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [from],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: from.x + 10, y: from.y + 10 }],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [to],
      });
      await expect(tiles.nth(2)).toHaveAttribute('data-drop-target', 'true');
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await session.detach();
    } else {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await expect(tiles.nth(2)).toHaveAttribute('data-drop-target', 'true');
      await page.mouse.up();
    }
    const manifest = z
      .object({ media: z.array(z.object({ id: z.string() })) })
      .parse(await (await response).json());
    const expected = [
      original[1],
      original[2],
      original[0],
      ...original.slice(3),
    ];
    expect(manifest.media.map((item) => item.id)).toEqual(expected);
    expect(
      await tiles.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-media-id')),
      ),
    ).toEqual(expected);
    await expect(tiles.locator('[data-dragging="true"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'EXPORT PNG' }),
    ).toBeEnabled();
  });
}

test('cancelling a drag or dropping outside selected photos preserves the stack', async ({
  page,
}) => {
  await openSampleExport(page);
  const tiles = page.locator('#export-selection .select-media');
  await tiles.last().getByRole('checkbox').uncheck();
  await expect(page.getByRole('button', { name: 'EXPORT PNG' })).toBeEnabled();
  const original = await tiles.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-media-id')),
  );
  const handle = tiles.first().getByRole('button', { name: /^Drag / });
  const source = await handle.boundingBox();
  const target = await tiles.nth(1).boundingBox();
  const unselected = await tiles.last().boundingBox();
  if (!source || !target || !unselected)
    throw new Error('Drag bounds required');
  for (const cancel of ['escape', 'unselected', 'outside']) {
    await page.mouse.move(source.x + 10, source.y + 10);
    await page.mouse.down();
    const destination = cancel === 'unselected' ? unselected : target;
    await page.mouse.move(destination.x + 30, destination.y + 30, { steps: 8 });
    if (cancel === 'escape') await page.keyboard.press('Escape');
    if (cancel === 'outside') await page.mouse.move(5, 100);
    await page.mouse.up();
    expect(
      await tiles.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-media-id')),
      ),
    ).toEqual(original);
    await expect(
      page.locator('[data-dragging="true"], [data-drop-target="true"]'),
    ).toHaveCount(0);
  }
});

test('dragging scrolls a short viewport and stops scrolling on cancellation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await openSampleExport(page);
  const handle = page
    .locator('#export-selection .select-media')
    .first()
    .getByRole('button', { name: /^Drag / });
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error('Drag handle required');
  const before = await page.evaluate(() => scrollY);
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(180, 490, { steps: 10 });
  await expect
    .poll(() => page.evaluate(() => scrollY))
    .toBeGreaterThan(before + 50);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const stopped = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        resolve();
      }),
    );
    return scrollY;
  });
  const later = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          resolve();
        }),
      ),
    );
    return scrollY;
  });
  expect(later).toBe(stopped);
  await expect(
    page.locator('[data-dragging="true"], [data-drop-target="true"]'),
  ).toHaveCount(0);
});
