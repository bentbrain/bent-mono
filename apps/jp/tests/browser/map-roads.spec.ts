import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { routeMapContext } from '../fixtures/map-context';

// Only synthetic locations and media enter screenshots.
test('map has no highway overlay through zoom, pan, themes and preview gestures', async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  await request.post('/_emdash/api/setup/dev-bypass', { headers, data: {} });
  await request.get('/_emdash/api/auth/dev-bypass');
  const created = await request.post('/_emdash/api/content/media_items', {
    headers,
    data: {
      slug: `synthetic-road-context-${crypto.randomUUID()}`,
      data: {
        title: 'Synthetic station photo',
        kind: 'photo',
        captured_at: '2099-10-18T12:00:00+09:00',
        latitude: 35.681236,
        longitude: 139.767125,
        place: 'synthetic tokyo station',
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
        {
          headers,
          data: { _rev },
        },
      )
    ).ok(),
  ).toBe(true);
  // Match the shared suite's nearby gallery fixture even in an isolated run.
  // It must cluster at country/broad zoom and split at regional/street zoom.
  const nearby = await request.post('/_emdash/api/content/media_items', {
    headers,
    data: {
      slug: `synthetic-road-nearby-${crypto.randomUUID()}`,
      data: {
        title: 'Synthetic nearby photo',
        kind: 'photo',
        captured_at: '2099-10-15T12:00:00+09:00',
        latitude: 35.6895,
        longitude: 139.6917,
        place: 'synthetic nearby tokyo',
        categories: [],
        demo: true,
        source_url: '/demo/japan.jpg',
      },
    },
  });
  expect(nearby.status()).toBe(201);
  const nearbyRecord = z
    .object({
      data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
    })
    .parse(await nearby.json()).data;
  expect(
    (
      await request.post(
        `/_emdash/api/content/media_items/${nearbyRecord.item.id}/publish`,
        { headers, data: { _rev: nearbyRecord._rev } },
      )
    ).ok(),
  ).toBe(true);
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  if (!process.env.MAP_CONTEXT_LIVE) await routeMapContext(page);
  const tileRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://cyberjapandata.gsi.go.jp/'))
      tileRequests.push(request.url());
  });
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const theme of ['light', 'dark']) {
        await page.goto(`/?media=${item.id}#japan-map`);
        await page.emulateMedia({
          colorScheme: theme === 'dark' ? 'dark' : 'light',
        });
        const map = page.locator('#japan-map');
        await page.getByRole('button', { name: 'Close map preview' }).click();
        const zoomIn = map.getByRole('button', {
          name: 'Zoom in',
          exact: true,
        });
        await expect(
          map.getByRole('button', {
            name: 'Zoom in',
            exact: true,
            includeHidden: true,
          }),
        ).toBeEnabled();
        await expect(zoomIn).toBeVisible({ visible: width > 600 });
        const canvas = map.getByRole('group', { name: 'Japan media map' });
        async function zoom(key: string) {
          if (width > 600) {
            await map
              .getByRole('button', {
                name: key === '+' ? 'Zoom in' : 'Zoom out',
                exact: true,
              })
              .click();
          } else {
            await canvas.focus();
            await page.keyboard.press(key);
          }
        }
        const evidence = process.env.MAP_ROADS_EVIDENCE;
        const ocean = await map.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        await expect(map).toHaveCSS('background-image', 'none');
        // Pin the existing water tint as an opaque colour in each theme.
        const pixel = await map.evaluate((element) => {
          const context = document.createElement('canvas').getContext('2d');
          if (!context) throw new Error('Canvas colour sampling unavailable');
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        });
        expect(pixel).toEqual(
          theme === 'light' ? [230, 237, 255, 255] : [6, 17, 38, 255],
        );
        for (const state of ['country', 'broad', 'regional', 'street']) {
          const target =
            state === 'country'
              ? 0.75
              : state === 'broad'
                ? 3
                : state === 'regional'
                  ? 96
                  : 3072;
          while (Number(await map.getAttribute('data-zoom')) > target)
            await zoom('-');
          while (Number(await map.getAttribute('data-zoom')) < target)
            await zoom('+');
          await expect(
            map.locator('[data-map-roads], [data-map-tile]'),
          ).toHaveCount(0);
          await expect(
            map.getByRole('link', {
              name: 'Map source: GSI Japan, colours adjusted',
            }),
          ).toHaveCount(0);
          await expect(map.locator('[data-map-vector-tile]')).not.toHaveCount(
            0,
          );
          if (state === 'regional' || state === 'street') {
            await expect(
              map.locator('[data-map-layer="RdCL"]').first(),
            ).toBeVisible();
            await expect(
              map.locator('[data-map-layer="RailCL"]').first(),
            ).toBeVisible();
          }
          if (state === 'street')
            await expect(
              map.locator('[data-map-layer="BldA"]').first(),
            ).toBeVisible();
          await expect(map.getByRole('status')).toHaveCount(0);
          await expect(map.locator('[data-map-detail-background]')).toHaveCount(
            1,
          );
          await expect(map).toHaveCSS('background-color', ocean);
          await expect(map.locator('[data-map-detail-background]')).toHaveCSS(
            'fill',
            ocean,
          );
          for (const water of await map.locator('[data-map-layer="WA"]').all())
            await expect(water).toHaveCSS('fill', ocean);
          await expect(
            map.locator('[data-map-vector-tile] > rect'),
          ).toHaveCount(0);
          await expect(
            map.getByRole('link', {
              name: 'Map source: GSI Japan, custom vector style',
            }),
          ).toBeVisible();
          await expect(map.locator('svg > path').first()).toHaveAttribute(
            'd',
            /M.+/,
          );
          if (state === 'country')
            await expect(
              map.locator('[data-map-context="island"]').first(),
            ).toBeVisible();
          // At regional zoom, nearby media can correctly suppress Tokyo's
          // reference label to avoid overlap. Check city context at broad zoom.
          if (state === 'broad')
            await expect(
              map.locator('[data-map-context="city"]').first(),
            ).toBeVisible();
          await expect(
            map.getByRole('button', {
              name:
                state === 'country' || state === 'broad'
                  ? /^synthetic tokyo station, (?:[2-9]|[1-9]\d+) items$/
                  : 'synthetic tokyo station, 1 items',
              exact: true,
            }),
          ).toBeVisible();
          if (evidence) {
            if (width <= 600)
              await canvas.evaluate((element) => {
                if (element instanceof SVGElement) element.blur();
              });
            await page.waitForTimeout(1500);
            await map.screenshot({
              path: `${evidence}-${String(width)}-${theme}-${state}.png`,
            });
          }
        }
        const svg = map.getByRole('group', { name: 'Japan media map' });
        const marker = map.getByRole('button', {
          name: 'synthetic tokyo station, 1 items',
          exact: true,
        });
        const names = map.locator('[data-map-place]');
        await expect(names.filter({ hasText: 'marunouchi 2' })).toHaveCount(1);
        await expect(map.locator('[data-map-detail] text')).toHaveCount(0);
        await expect(map).not.toContainText(/[\u3040-\u30ff\u3400-\u9fff]/);
        const anchored = await names.evaluateAll((nodes) =>
          nodes.map((node) => ({
            id: node.getAttribute('data-map-place'),
            text: node.textContent,
            x: Number(node.getAttribute('x')),
            y: Number(node.getAttribute('y')),
          })),
        );
        const beforePan = await marker.boundingBox();
        const bounds = await map.boundingBox();
        if (!beforePan || !bounds) throw new Error('Map bounds required');
        await page.mouse.move(bounds.x + 90, bounds.y + 90);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 150, bounds.y + 120, { steps: 5 });
        await page.mouse.up();
        expect(
          await page.evaluate(() => window.getSelection()?.toString()),
        ).toBe('');
        if (process.env.MAP_ROADS_EVIDENCE)
          await map.screenshot({
            path: `${process.env.MAP_ROADS_EVIDENCE}-${String(width)}-${theme}-panned.png`,
          });
        const afterNames = await names.evaluateAll((nodes) =>
          nodes.map((node) => ({
            id: node.getAttribute('data-map-place'),
            text: node.textContent,
            x: Number(node.getAttribute('x')),
            y: Number(node.getAttribute('y')),
          })),
        );
        for (const before of anchored.filter(
          (name) =>
            name.x > 0 && name.x < width - 120 && name.y > 0 && name.y < 300,
        )) {
          const after = afterNames.find((name) => name.id === before.id);
          expect(
            after,
            `place ${before.text} must survive a pan`,
          ).toBeDefined();
          expect(after?.text).toBe(before.text);
          expect(after?.x).toBeCloseTo(before.x + 60, 0);
          expect(after?.y).toBeCloseTo(before.y + 30, 0);
        }
        const afterPan = await marker.boundingBox();
        expect(afterPan?.x).toBeCloseTo(beforePan.x + 60, 0);
        expect(afterPan?.y).toBeCloseTo(beforePan.y + 30, 0);
        await expect(svg).toBeFocused();
        await marker.click();
        const preview = page.locator('[data-feedback-id="map-preview"]');
        await expect(preview).toBeVisible();
        await expect(preview.getByRole('heading')).toHaveText(
          'synthetic tokyo station / 1 of 1',
        );
        await page.getByRole('button', { name: 'Close map preview' }).click();
      }
    }
    // Failed detail never removes the local outline, media pins or controls.
    await page.unroute('https://cyberjapandata.gsi.go.jp/**');
    await page.route('https://cyberjapandata.gsi.go.jp/**', (route) =>
      route.abort(),
    );
    await page.goto(`/?media=${item.id}#japan-map`);
    await page.getByRole('button', { name: 'Close map preview' }).click();
    // A hash-only navigation can retain the already-cached tile set. Reload to
    // exercise a fresh visit during an outage.
    await page.reload();
    if (
      await page.getByRole('button', { name: 'Close map preview' }).isVisible()
    )
      await page.getByRole('button', { name: 'Close map preview' }).click();
    const fallback = page.locator('#japan-map');
    const fallbackOcean = await fallback.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await expect(fallback).toHaveCSS('background-image', 'none');
    await expect(fallback.getByRole('status')).toHaveText(
      'map detail unavailable',
    );
    await expect(fallback.locator('svg > path').first()).toHaveAttribute(
      'd',
      /M.+/,
    );
    await expect(
      fallback.getByRole('button', { name: /^synthetic tokyo station,/ }),
    ).toBeEnabled();
    await page.unroute('https://cyberjapandata.gsi.go.jp/**');
    await routeMapContext(page);
    await fallback.getByRole('button', { name: 'RETRY MAP' }).click();
    await expect(fallback.locator('[data-map-vector-tile]')).not.toHaveCount(0);
    await expect(fallback.getByRole('status')).toHaveCount(0);
    await expect(fallback).toHaveCSS('background-color', fallbackOcean);
    await expect(fallback.locator('[data-map-detail-background]')).toHaveCSS(
      'fill',
      fallbackOcean,
    );
    expect(tileRequests.length).toBeGreaterThan(0);
    expect(
      tileRequests.every((url) =>
        /optimal_bvmap-v1\/\d+\/\d+\/\d+\.pbf$/.test(url),
      ),
    ).toBe(true);
  } finally {
    for (const id of [item.id, nearbyRecord.item.id])
      expect(
        (
          await request.delete(`/_emdash/api/content/media_items/${id}`, {
            headers,
          })
        ).ok(),
      ).toBe(true);
  }
});

test('private GPS revisions never request external tiles in edit mode or native preview', async ({
  page,
  browser,
  baseURL,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => {
    browserErrors.push(error.message);
  });
  const api = page.request;
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  await api.post('/_emdash/api/setup/dev-bypass', { headers, data: {} });
  await api.get('/_emdash/api/auth/dev-bypass');
  const response = await api.post('/_emdash/api/content/media_items', {
    headers,
    data: {
      slug: `synthetic-private-roads-${crypto.randomUUID()}`,
      data: {
        title: 'Synthetic private road location',
        kind: 'photo',
        captured_at: '2099-10-18T12:00:00+09:00',
        latitude: 35.681236,
        longitude: 139.767125,
        place: 'synthetic live tokyo',
        categories: [],
        demo: true,
        source_url: '/demo/japan.jpg',
      },
    },
  });
  expect(response.status()).toBe(201);
  const record = z.object({
    data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
  });
  const { item, _rev } = record.parse(await response.json()).data;
  const path = `/_emdash/api/content/media_items/${item.id}`;
  const inlineText = 'Synthetic inline editor content for private map checks.';
  let inlinePostPath: string | undefined;
  try {
    const createdPost = await api.post('/_emdash/api/content/posts', {
      headers,
      data: {
        slug: `synthetic-private-map-post-${crypto.randomUUID()}`,
        data: {
          title: 'Synthetic private map post',
          day: '2099-10-18',
          demo: true,
          content: [
            {
              _type: 'block',
              _key: 'synthetic-inline-block',
              style: 'normal',
              markDefs: [],
              children: [
                {
                  _type: 'span',
                  _key: 'synthetic-inline-span',
                  marks: [],
                  text: inlineText,
                },
              ],
            },
          ],
        },
      },
    });
    expect(createdPost.status()).toBe(201);
    const post = record.parse(await createdPost.json()).data;
    inlinePostPath = `/_emdash/api/content/posts/${post.item.id}`;
    expect(
      (
        await api.post(`${inlinePostPath}/publish`, {
          headers,
          data: { _rev: post._rev },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (await api.post(`${path}/publish`, { headers, data: { _rev } })).ok(),
    ).toBe(true);
    const live = record.parse(await (await api.get(path)).json()).data;
    expect(
      (
        await api.put(path, {
          headers,
          data: {
            _rev: live._rev,
            data: {
              latitude: 43.0618,
              longitude: 141.3545,
              place: 'synthetic unpublished sapporo',
            },
          },
        })
      ).ok(),
    ).toBe(true);
    const preview = await api.post(`${path}/preview-url`, {
      headers,
      data: {},
    });
    expect(preview.ok()).toBe(true);
    const previewUrl = z
      .object({ data: z.object({ url: z.string() }) })
      .parse(await preview.json()).data.url;
    const query = new URL(previewUrl, baseURL).searchParams;
    const tileRequests: string[] = [];
    await page.route('https://toolbar.bent.build/embed.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await page.route(
      /https:\/\/(?:cyberjapandata|maps)\.gsi\.go\.jp\//,
      (route) => {
        tileRequests.push(route.request().url());
        return route.abort();
      },
    );
    for (const mode of ['edit', 'preview']) {
      await page.context().addCookies([
        {
          name: 'emdash-edit-mode',
          value: mode === 'edit' ? 'true' : 'false',
          url: baseURL ?? 'http://127.0.0.1:4391',
        },
      ]);
      const search =
        mode === 'preview' ? new URLSearchParams(query) : new URLSearchParams();
      search.set('media', item.id);
      await page.goto(`/?${search.toString()}#japan-map`);
      if (mode === 'edit') {
        const navigationStartedAt = await page.evaluate(
          () => performance.timeOrigin,
        );
        const fixturePost = page.locator('article').filter({
          has: page.getByRole('link', {
            name: 'Synthetic private map post',
            exact: true,
          }),
        });
        await expect(fixturePost).toBeVisible();
        await expect(
          fixturePost
            .locator('[contenteditable="true"]')
            .filter({ hasText: inlineText }),
        ).toBeVisible();
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(
          navigationStartedAt,
        );
      }
      const map = page.locator('#japan-map');
      await expect(
        page.locator('[data-feedback-id="map-preview"]'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Close map preview' }).click();
      const marker = map.getByRole('button', {
        name: 'synthetic unpublished sapporo, 1 items',
        exact: true,
      });
      await expect(marker).toBeVisible();
      const zoom = map.getByRole('button', { name: 'Zoom in', exact: true });
      while (Number(await map.getAttribute('data-zoom')) < 3072)
        await zoom.click();
      await expect(marker).toBeVisible();
      await expect(map.locator('[data-map-tile]')).toHaveCount(0);
      await marker.click();
      await expect(
        page.locator('[data-feedback-id="map-preview"]'),
      ).toBeVisible();
      expect(tileRequests).toEqual([]);
    }
    const anonymous = await browser.newContext({ baseURL });
    try {
      const publicPage = await anonymous.newPage();
      await publicPage.route('https://toolbar.bent.build/embed.js', (route) =>
        route.fulfill({ body: '' }),
      );
      await routeMapContext(publicPage);
      await publicPage.goto(`/?media=${item.id}#japan-map`);
      await expect(
        publicPage.locator('[data-feedback-id="map-preview"]'),
      ).toContainText('synthetic live tokyo');
      await expect(publicPage.locator('#japan-map')).not.toContainText(
        'synthetic unpublished sapporo',
      );
      await publicPage
        .getByRole('button', { name: 'Close map preview' })
        .click();
      await expect(
        publicPage.locator('[data-map-vector-tile]'),
      ).not.toHaveCount(0);
    } finally {
      await anonymous.close();
    }
    expect(browserErrors).toEqual([]);
  } finally {
    if (inlinePostPath)
      expect((await api.delete(inlinePostPath, { headers })).ok()).toBe(true);
    expect((await api.delete(path, { headers })).ok()).toBe(true);
  }
});
