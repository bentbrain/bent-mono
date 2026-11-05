import { test, expect } from '@playwright/test';
import { z } from 'zod';

test('map previews include Japan while outside media stays in the gallery and posts', async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  expect(
    (
      await request.post('/_emdash/api/setup/dev-bypass', { headers, data: {} })
    ).ok(),
  ).toBe(true);
  await request.get('/_emdash/api/auth/dev-bypass');
  const fixtures = [];
  for (const [place, latitude, longitude] of [
    ['okinawa', 26.2124, 127.6809],
    ['nearby', 26.3124, 127.7809],
    ['brisbane', -27.47, 153.02],
    ['airplane', 5, 145],
  ] satisfies [string, number, number][]) {
    const slug = `synthetic-map-${crypto.randomUUID()}`;
    const title = `Synthetic ${place} photo`;
    const created = await request.post('/_emdash/api/content/media_items', {
      headers,
      data: {
        slug,
        data: {
          title,
          kind: 'photo',
          captured_at: '2099-10-15T12:00:00+09:00',
          latitude,
          longitude,
          place: `synthetic ${place}`,
          categories: [],
          demo: true,
          source_url: '/demo/japan.jpg',
        },
      },
    });
    expect(created.status()).toBe(201);
    const { item, _rev } = z
      .object({
        data: z.object({
          item: z.object({ id: z.string() }),
          _rev: z.string(),
        }),
      })
      .parse(await created.json()).data;
    expect(
      (
        await request.post(
          `/_emdash/api/content/media_items/${item.id}/publish`,
          { headers, data: { _rev } },
        )
      ).ok(),
    ).toBe(true);
    fixtures.push({ id: item.id, slug, title, place });
  }
  const japan = fixtures.find((item) => item.place === 'okinawa');
  if (!japan) throw new Error('Japan map fixture required');
  const postSlug = `synthetic-map-post-${crypto.randomUUID()}`;
  const post = await request.post('/_emdash/api/content/posts', {
    headers,
    data: {
      slug: postSlug,
      data: {
        title: 'Synthetic map post',
        day: '2099-10-15',
        content: [],
        gallery: fixtures.map((item) => item.id),
        demo: true,
      },
    },
  });
  expect(post.status()).toBe(201);
  const { item: postItem, _rev: postRev } = z
    .object({
      data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
    })
    .parse(await post.json()).data;
  expect(
    (
      await request.post(`/_emdash/api/content/posts/${postItem.id}/publish`, {
        headers,
        data: { _rev: postRev },
      })
    ).ok(),
  ).toBe(true);
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  // Check the server response as well as hydrated markers and deep links.
  const html = await (await request.get('/')).text();
  const mapMarkup = html.match(
    /<astro-island\b[^>]*component-export="JapanMapView"[\s\S]*?<\/astro-island>/,
  )?.[0];
  expect(mapMarkup).toBeTruthy();
  expect(mapMarkup).toContain('synthetic okinawa');
  expect(mapMarkup).not.toContain('synthetic brisbane');
  expect(mapMarkup).not.toContain('synthetic airplane');
  let portrait = true;
  await page.route('**/demo/japan.jpg', async (route) => {
    if (!portrait) {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#0647ff"/></svg>',
    });
  });
  for (const width of [390, 1280]) {
    portrait = width === 390;
    await page.setViewportSize({ width, height: 800 });
    for (const fixture of fixtures) {
      await page.goto(`/media_items/${fixture.slug}`);
      await expect(page).toHaveURL(new RegExp(`/media/${fixture.slug}$`));
      await expect(
        page.getByRole('img', { name: fixture.title }),
      ).toBeVisible();
      const mapLink = page.getByRole('link', {
        name: 'VIEW ON MAP',
        exact: true,
      });
      if (['okinawa', 'nearby'].includes(fixture.place)) {
        await mapLink.click();
      } else {
        await expect(mapLink).toHaveCount(0);
        await page.goto(`/?media=${fixture.id}#japan-map`);
        await expect(
          page.locator('[data-feedback-id="map-preview"]'),
        ).toHaveCount(0);
      }
      await expect(
        page.getByRole('button', { name: /synthetic brisbane/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /synthetic airplane/ }),
      ).toHaveCount(0);
    }
    await page.goto(`/media/${japan.slug}`);
    await page.getByRole('link', { name: 'VIEW ON MAP', exact: true }).click();
    const marker = page.getByRole('button', {
      name: /synthetic (okinawa|nearby), 2 items/,
    });
    await expect(marker).toBeEnabled();
    expect((await marker.boundingBox())?.width).toBe(44);
    expect(
      await marker.evaluate((element) => {
        const bounds = element.closest('#japan-map')?.getBoundingClientRect();
        const pin = element.getBoundingClientRect();
        return (
          bounds &&
          pin.left >= bounds.left &&
          pin.top >= bounds.top &&
          pin.right <= bounds.right &&
          pin.bottom <= bounds.bottom
        );
      }),
      'Map marker is clipped outside the map',
    ).toBe(true);
    const preview = page.locator('[data-feedback-id="map-preview"]');
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('img')).toBeVisible();
    expect((await preview.boundingBox())?.width).toBeGreaterThan(
      width === 390 ? 340 : 600,
    );
    const photo = preview.getByRole('img');
    await photo.evaluate((image) =>
      image instanceof HTMLImageElement
        ? image.decode()
        : Promise.reject(new Error('Photo required')),
    );
    expect(
      await photo.evaluate((image) => {
        if (!(image instanceof HTMLImageElement))
          throw new Error('Photo required');
        const box = image.getBoundingClientRect();
        return Math.abs(
          box.width / box.height - image.naturalWidth / image.naturalHeight,
        );
      }),
    ).toBeLessThan(0.01);

    await page.getByRole('button', { name: 'Close map preview' }).click();
    const map = page.locator('#japan-map');
    const initialZoom = Number(await map.getAttribute('data-zoom'));
    const initialLand = await map
      .locator('svg[aria-label="Japan media map"] > path')
      .getAttribute('transform');
    await expect(
      map.getByRole('group', { name: 'Map controls', includeHidden: true }),
    ).toHaveCount(1);
    await expect(
      map.getByRole('button', { name: /Zoom (in|out)/ }),
    ).toHaveCount(width > 600 ? 2 : 0);
    const bounds = await map.boundingBox();
    if (!bounds) throw new Error('Map bounds required');
    const session = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    async function pinch(startSpan: number, endSpan: number) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: x - startSpan, y, id: 1 },
          { x: x + startSpan, y, id: 2 },
        ],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - endSpan, y, id: 1 },
          { x: x + endSpan, y, id: 2 },
        ],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    }
    for (let step = 0; step < 5; step++) await pinch(40, 80);
    expect(Number(await map.getAttribute('data-zoom'))).toBeGreaterThan(
      initialZoom,
    );
    await expect(map.locator('.map-marker')).toHaveCount(2);
    await expect(map.getByRole('button', { name: /, 1 items$/ })).toHaveCount(
      2,
    );
    for (let step = 0; step < 5; step++) await pinch(80, 40);
    await expect(marker).toBeVisible();
    await session.detach();
    await page.mouse.move(bounds.x + 80, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 110, bounds.y + 120, { steps: 4 });
    await page.mouse.up();
    expect(
      await map
        .locator('svg[aria-label="Japan media map"] > path')
        .getAttribute('transform'),
    ).not.toBe(initialLand);
    await page.goto(`/media/${japan.slug}`);
    await page.getByRole('link', { name: 'VIEW ON MAP', exact: true }).click();
    await expect(preview).toBeVisible();
    await preview.getByRole('link', { name: 'VIEW MEDIA' }).click();
    await expect(page).toHaveURL(new RegExp(`/media/${japan.slug}$`));
    for (const route of ['/gallery', `/posts/${postSlug}`]) {
      await page.goto(route);
      for (const fixture of fixtures)
        await expect(
          page.getByRole('img', { name: fixture.title }),
        ).toHaveCount(1);
    }
  }
});
