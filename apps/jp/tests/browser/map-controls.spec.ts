import { test, expect } from '@playwright/test';
import { z } from 'zod';

let selectionFixtureId: string | undefined;
test.afterEach(async ({ request, baseURL }) => {
  if (!selectionFixtureId) return;
  expect(
    (
      await request.delete(
        `/_emdash/api/content/media_items/${selectionFixtureId}`,
        {
          headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
        },
      )
    ).ok(),
  ).toBe(true);
  selectionFixtureId = undefined;
});

test('map controls retain zoom and geographic context without the location button', async ({
  page,
  request,
  baseURL,
}) => {
  await request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
    data: {},
  });
  await request.get('/_emdash/api/auth/dev-bypass');
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  const created = await request.post('/_emdash/api/content/media_items', {
    headers,
    data: {
      slug: `synthetic-map-selection-${crypto.randomUUID()}`,
      data: {
        title: 'Synthetic map selection photo',
        kind: 'photo',
        // Keep this fixture first in its cluster, ahead of shared suite media.
        captured_at: '2099-10-17T12:00:00+09:00',
        latitude: 35.6762,
        longitude: 139.6503,
        place: 'synthetic tokyo',
        categories: [],
        demo: true,
        source_url: '/demo/japan.jpg',
      },
    },
  });
  expect(created.status()).toBe(201);
  const { item, _rev } = z
    .object({
      data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
    })
    .parse(await created.json()).data;
  selectionFixtureId = item.id;
  expect(
    (
      await request.post(
        `/_emdash/api/content/media_items/${item.id}/publish`,
        {
          headers,
          data: { _rev },
        },
      )
    ).ok(),
  ).toBe(true);
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  const map = page.locator('#japan-map');
  const zoomIn = map.getByRole('button', { name: 'Zoom in', exact: true });
  const zoomOut = map.getByRole('button', { name: 'Zoom out', exact: true });
  let mobile = false;
  const svg = map.getByRole('group', { name: 'Japan media map' });
  const changeZoom = async (key: string) => {
    if (mobile) {
      await svg.focus();
      await page.keyboard.press(key);
    } else await (key === '+' ? zoomIn : zoomOut).click();
  };
  const resetMap = async () => {
    await page.reload();
    await expect(
      map.getByRole('button', {
        name: 'Zoom in',
        exact: true,
        includeHidden: true,
      }),
    ).toBeEnabled();
    await expect(zoomIn).toBeVisible({ visible: !mobile });
    await expect(
      map
        .getByRole('group', { name: 'Map controls', includeHidden: true })
        .getByRole('button'),
    ).toHaveCount(mobile ? 0 : 2);
  };
  await expect(zoomIn).toBeEnabled();
  for (const width of [1280, 390]) {
    mobile = width <= 600;
    await page.setViewportSize({ width, height: 800 });
    await resetMap();
    const initial = Number(await map.getAttribute('data-zoom'));
    await changeZoom('+');
    await expect
      .poll(async () => Number(await map.getAttribute('data-zoom')))
      .toBeCloseTo(initial * 2);
    await changeZoom('-');
    await expect
      .poll(async () => Number(await map.getAttribute('data-zoom')))
      .toBeCloseTo(initial);
    if (mobile) {
      await svg.focus();
      await page.keyboard.press('+');
    } else {
      await zoomIn.focus();
      await page.keyboard.press('Enter');
    }
    await expect
      .poll(async () => Number(await map.getAttribute('data-zoom')))
      .toBeCloseTo(initial * 2);
    await resetMap();
    await expect
      .poll(async () => Number(await map.getAttribute('data-zoom')))
      .toBeCloseTo(initial);
    await svg.dispatchEvent('wheel', {
      deltaY: -120,
      ctrlKey: true,
      clientX: 200,
      clientY: 250,
    });
    await expect
      .poll(async () => Number(await map.getAttribute('data-zoom')))
      .toBeGreaterThan(initial);
    await resetMap();
    await svg.dispatchEvent('wheel', {
      deltaY: -120,
      clientX: 200,
      clientY: 250,
    });
    await expect
      .poll(async () => Number(await map.getAttribute('data-zoom')))
      .toBeCloseTo(initial);
    // A real mouse gesture must pan without selecting SVG labels or pin counts.
    await resetMap();
    const land = svg.locator(':scope > path');
    const transform = await land.getAttribute('transform');
    const label = svg.locator('text').filter({ hasText: 'synthetic tokyo' });
    const labelBox = await label.boundingBox();
    if (!labelBox) throw new Error('Map label bounds required');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(labelBox.x + 2, labelBox.y + labelBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(labelBox.x + 72, labelBox.y + labelBox.height / 2, {
      steps: 8,
    });
    if (process.env.MAP_SELECTION_EVIDENCE)
      await map.screenshot({
        path: `${process.env.MAP_SELECTION_EVIDENCE}-${String(width)}.png`,
      });
    await page.mouse.up();
    expect(await land.getAttribute('transform')).not.toBe(transform);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      '',
    );
    await expect(svg).toBeFocused();
    const panned = await land.getAttribute('transform');
    await page.keyboard.press('ArrowLeft');
    expect(await land.getAttribute('transform')).not.toBe(panned);
    await page.keyboard.press('+');
    await expect
      .poll(async () => Number(await map.getAttribute('data-zoom')))
      .toBeCloseTo(initial * 2);
    await resetMap();
    const marker = map.getByRole('button', {
      // Earlier browser tests can publish nearby media into the same cluster.
      name: /^synthetic tokyo, [1-9]\d* items$/,
    });
    await marker.focus();
    await page.keyboard.press('Enter');
    const preview = page.locator('[data-feedback-id="map-preview"]');
    await expect(preview).toBeVisible();
    // Preview text remains copyable, outside the panning canvas.
    const title = preview.getByRole('heading');
    const titleBox = await title.boundingBox();
    if (!titleBox) throw new Error('Preview title bounds required');
    await page.mouse.move(titleBox.x + 1, titleBox.y + titleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      titleBox.x + titleBox.width - 1,
      titleBox.y + titleBox.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    expect(
      await page.evaluate(() => window.getSelection()?.toString()),
    ).toContain('synthetic tokyo');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await preview.getByRole('button', { name: 'Close map preview' }).click();
    await marker.click();
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Close map preview' }).click();
    for (
      let index = 0;
      index < 8 && Number(await map.getAttribute('data-zoom')) > 0.25;
      index++
    )
      await changeZoom('-');
    expect(Number(await map.getAttribute('data-zoom'))).toBe(0.25);
    if (!mobile) await expect(zoomOut).toBeDisabled();
    await resetMap();
    await expect(map.locator('[data-map-context]')).not.toHaveCount(0);
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
  }
});
