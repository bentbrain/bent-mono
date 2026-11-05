import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const createdSchema = z.object({
  data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
});
const fixtures: { id: string; shape: string }[] = [];

test.beforeAll(async ({ request, baseURL }) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  expect(
    (
      await request.post('/_emdash/api/setup/dev-bypass', { headers, data: {} })
    ).ok(),
  ).toBe(true);
  await request.get('/_emdash/api/auth/dev-bypass');
  for (const shape of ['portrait', 'landscape']) {
    const response = await request.post('/_emdash/api/content/media_items', {
      headers,
      data: {
        slug: `synthetic-popup-${shape}-${crypto.randomUUID()}`,
        data: {
          title: `Synthetic ${shape} video`,
          kind: 'video',
          captured_at: '2098-10-15T00:00:00Z',
          latitude: 26.8,
          longitude: 128.3,
          place: 'synthetic popup',
          categories: [],
          demo: true,
          duration: 6,
          source_url: `/demo/map-video-${shape}.mp4`,
          poster_url: `/demo/map-video-${shape}.svg`,
        },
      },
    });
    expect(response.status()).toBe(201);
    const { item, _rev } = createdSchema.parse(await response.json()).data;
    expect(
      (
        await request.post(
          `/_emdash/api/content/media_items/${item.id}/publish`,
          { headers, data: { _rev } },
        )
      ).ok(),
    ).toBe(true);
    fixtures.push({ id: item.id, shape });
  }
});

test.beforeEach(async ({ page }) => {
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.route('**/demo/map-video-*.svg', (route) => {
    const portrait = route.request().url().includes('portrait');
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? '160' : '240'}" height="${portrait ? '240' : '160'}"><rect width="100%" height="100%" fill="#0647ff"/><text x="12" y="100" fill="white">synthetic video</text></svg>`,
    });
  });
  await page.route('**/demo/map-video-*.mp4', async (route) => {
    const shape = route.request().url().includes('portrait')
      ? 'portrait'
      : 'landscape';
    const body = await readFile(
      new URL(`../fixtures/map-${shape}.mp4`, import.meta.url),
    );
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers()['range'] ?? '',
    );
    const start = Number(range?.[1] ?? 0);
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
      status: range ? 206 : 200,
      contentType: 'video/mp4',
      headers: {
        'Accept-Ranges': 'bytes',
        ...(range
          ? {
              'Content-Range': `bytes ${String(start)}-${String(end)}/${String(body.length)}`,
            }
          : {}),
      },
      body: body.subarray(start, end + 1),
    });
  });
});

test.afterAll(async ({ request, baseURL }) => {
  await request.get('/_emdash/api/auth/dev-bypass');
  for (const fixture of fixtures)
    expect(
      (
        await request.delete(`/_emdash/api/content/media_items/${fixture.id}`, {
          headers: { 'X-EmDash-Request': '1', Origin: baseURL || '' },
        })
      ).ok(),
    ).toBe(true);
});

for (const width of [390, 1792]) {
  test(`map popup plays and seeks both video shapes at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 993 });
    for (const fixture of fixtures) {
      await page.goto(`/?media=${fixture.id}#japan-map`);
      const popup = page.locator('[data-feedback-id="map-preview"]');
      await expect(popup).toBeVisible();
      const video = popup.locator('video');
      await expect(video).toHaveCount(1, { timeout: 3000 });
      await expect(video).toHaveAttribute('controls', '');
      await expect(video).toHaveAttribute('playsinline', '');
      await expect(video).toHaveAttribute(
        'src',
        `/demo/map-video-${fixture.shape}.mp4`,
      );
      await expect
        .poll(() =>
          video.evaluate(
            (element) =>
              element instanceof HTMLVideoElement && element.readyState >= 2,
          ),
        )
        .toBe(true);
      const state = () =>
        video.evaluate((element) => {
          if (!(element instanceof HTMLVideoElement))
            throw new Error('Video required');
          return {
            time: element.currentTime,
            paused: element.paused,
            error: element.error?.code ?? null,
            muted: element.muted,
            volume: element.volume,
            seeking: element.seeking,
            width: element.videoWidth,
            height: element.videoHeight,
          };
        });
      await expect.poll(async () => (await state()).paused).toBe(false);
      await expect.poll(async () => (await state()).time).toBeGreaterThan(0.2);
      expect((await state()).muted).toBe(true);
      await video.press('Space');
      await expect.poll(async () => (await state()).paused).toBe(true);
      expect((await state()).volume).toBe(1);
      expect((await state()).error).toBeNull();
      const bounds = await video.boundingBox();
      if (!bounds) throw new Error('Player bounds required');
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      const dimensions = await state();
      expect(
        Math.abs(
          bounds.width / bounds.height - dimensions.width / dimensions.height,
        ),
      ).toBeLessThan(0.01);
      await video.focus();
      await video.press('Space');
      await expect.poll(async () => (await state()).time).toBeGreaterThan(0.2);
      await expect(popup).toBeVisible();
      await video.press('Space');
      await expect.poll(async () => (await state()).paused).toBe(true);
      await video.evaluate((element) => {
        if (element instanceof HTMLVideoElement) element.currentTime = 1;
      });
      await expect.poll(async () => (await state()).seeking).toBe(false);
      await video.hover();
      const controlBounds = await video.boundingBox();
      if (!controlBounds) throw new Error('Native controls required');
      // Seek with the native timeline, then use its focused keyboard control.
      await page.mouse.click(
        controlBounds.x + controlBounds.width * 0.65,
        controlBounds.y + controlBounds.height - 20,
      );
      await expect.poll(async () => (await state()).time).toBeGreaterThan(2);
      const seeked = (await state()).time;
      await page.keyboard.press('ArrowLeft');
      await expect.poll(async () => (await state()).time).toBeLessThan(seeked);
      await video.evaluate((element) => {
        if (!(element instanceof HTMLVideoElement))
          throw new Error('Video required');
        element.currentTime = 1;
        element.muted = true;
      });
      expect((await state()).muted).toBe(true);
      await video.evaluate((element) => {
        if (element instanceof HTMLVideoElement) element.muted = false;
      });
      expect((await state()).muted).toBe(false);
      // Hit Chromium's native play control, rather than calling play().
      await page.mouse.click(
        controlBounds.x + 18,
        controlBounds.y + controlBounds.height - 48,
      );
      await expect.poll(async () => (await state()).paused).toBe(false);
      await expect.poll(async () => (await state()).time).toBeGreaterThan(1.2);
      if (width === 390) {
        await video.press('Space');
        await expect.poll(async () => (await state()).paused).toBe(true);
        const beforeTouch = (await state()).time;
        const zoom = await page.locator('#japan-map').getAttribute('data-zoom');
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [
            {
              x: controlBounds.x + 18,
              y: controlBounds.y + controlBounds.height - 48,
              id: 1,
            },
          ],
        });
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        await expect
          .poll(async () => (await state()).time)
          .toBeGreaterThan(beforeTouch + 0.2);
        await expect(popup).toBeVisible();
        expect(await page.locator('#japan-map').getAttribute('data-zoom')).toBe(
          zoom,
        );
        await session.detach();
      }
      const oldVideo = await video.elementHandle();
      await popup
        .getByRole('button', { name: 'Next media at this location' })
        .click();
      await expect
        .poll(() => oldVideo.evaluate((element) => element.isConnected))
        .toBe(false);
      await expect
        .poll(() =>
          oldVideo.evaluate(
            (element) => element instanceof HTMLVideoElement && element.paused,
          ),
        )
        .toBe(true);
      await expect(video).toHaveCount(1);
      await expect.poll(async () => (await state()).paused).toBe(false);
      expect((await state()).muted).toBe(true);
      await video.focus();
      await expect.poll(async () => (await state()).time).toBeGreaterThan(0.2);
      const closingVideo = await video.elementHandle();
      await video.press('Escape');
      await expect(popup).toHaveCount(0);
      await expect
        .poll(() =>
          closingVideo.evaluate(
            (element) => element instanceof HTMLVideoElement && element.paused,
          ),
        )
        .toBe(true);
      await closingVideo.dispose();
      const marker = page.getByRole('button', {
        name: 'synthetic popup, 2 items',
        exact: true,
      });
      await expect(marker).toBeFocused();
      await marker.press('Enter');
      await expect(popup).toBeVisible();
      await popup.getByRole('button', { name: 'Close map preview' }).click();
      await expect(popup).toHaveCount(0);
      await oldVideo.dispose();
    }
  });
}
