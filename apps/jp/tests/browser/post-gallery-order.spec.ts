import {
  test,
  expect,
  type Request,
  type Response,
  type ConsoleMessage,
} from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { editorPostSchema as editorPostResponse } from '../../src/lib/editor-model';
const savedResponse = z.object({
  data: z.object({ item: z.object({ id: z.string() }) }),
});
const revisionResponse = z.object({ data: z.object({ _rev: z.string() }) });
const mediaResponse = z.object({
  data: z.object({
    item: z.object({
      data: z.object({
        captured_at: z.string(),
        latitude: z.number(),
        longitude: z.number(),
      }),
    }),
  }),
});

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

for (const width of [601, 1280]) {
  test(`home post carousel advances photos at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(
      page.locator('astro-island[component-export="PostMedia"][ssr]'),
    ).toHaveCount(0);
    const card = page.locator('article').first();
    const first = card.locator('[data-slot="carousel-item"]').first();
    const before = await first.evaluate(
      (element) => element.getBoundingClientRect().left,
    );
    await card.getByRole('button', { name: 'Next slide' }).click();
    await expect
      .poll(
        async () =>
          before -
          (await first.evaluate(
            (element) => element.getBoundingClientRect().left,
          )),
      )
      .toBeGreaterThan(100);
    await expect(first).toHaveAttribute('data-video-active', 'false');
    await card.getByRole('button', { name: 'Previous slide' }).click();
    await expect
      .poll(() =>
        first.evaluate((element) => element.getBoundingClientRect().left),
      )
      .toBeCloseTo(before, 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  });
}

test('owner gallery defaults to capture order, supports pointer/touch/keyboard moves and persists securely', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.route('**/demo/japan.jpg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#dbe8ff"/><circle cx="100" cy="100" r="50" fill="#0647ff"/></svg>',
    }),
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await expect(page.getByLabel('title', { exact: true })).toBeVisible();
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  const fixtures: { id: string; title: string; captured_at: string }[] = [];
  // Upload order deliberately differs from capture order, including timezone offsets.
  for (const { name, captured_at } of [
    { name: 'late', captured_at: '2098-10-15T21:00:00+09:00' },
    { name: 'early', captured_at: '2098-10-15T08:00:00+09:00' },
    { name: 'middle', captured_at: '2098-10-15T03:00:00Z' },
  ]) {
    const title = `Synthetic gallery ${name}`;
    const created = await page.request.post(
      '/_emdash/api/content/media_items',
      {
        headers,
        data: {
          slug: `synthetic-gallery-${name}`,
          data: {
            title,
            kind: 'photo',
            captured_at,
            latitude: 35.6,
            longitude: 139.7,
            place: 'synthetic fixture',
            categories: [],
            source_url: '/demo/japan.jpg',
            demo: true,
          },
        },
      },
    );
    expect(created.ok()).toBe(true);
    const createdBody = savedResponse.parse(await created.json());
    const id = createdBody.data.item.id;
    const currentBody: unknown = await (
      await page.request.get(`/_emdash/api/content/media_items/${id}`)
    ).json();
    const current = revisionResponse.parse(currentBody);
    const originalCapture =
      mediaResponse.parse(currentBody).data.item.data.captured_at;
    expect(new Date(originalCapture).getTime()).toBe(
      new Date(captured_at).getTime(),
    );
    expect(
      (
        await page.request.post(
          `/_emdash/api/content/media_items/${id}/publish`,
          { headers, data: { _rev: current.data._rev } },
        )
      ).ok(),
    ).toBe(true);
    fixtures.push({ id, title, captured_at: originalCapture });
  }
  const incomplete = await page.request.post(
    '/_emdash/api/content/media_items',
    {
      headers,
      data: {
        slug: 'synthetic-incomplete-draft',
        data: { title: 'Synthetic incomplete draft', kind: 'photo' },
      },
    },
  );
  expect(incomplete.ok()).toBe(true);
  await page.reload();
  await page
    .getByLabel('title', { exact: true })
    .fill('Synthetic ordered gallery');
  await page
    .getByRole('textbox', { name: 'Post content' })
    .fill('Synthetic gallery fixture.');
  await page.getByRole('button', { name: '+ MEDIA', exact: true }).click();
  const late = fixtures[0],
    early = fixtures[1],
    middle = fixtures[2];
  if (!late || !early || !middle)
    throw new Error('Three gallery fixtures required');
  const picker = page.getByRole('dialog');
  const fixtureImages = picker.getByRole('img', {
    name: /^Synthetic gallery (late|middle|early)$/,
  });
  await expect(fixtureImages).toHaveCount(3);
  expect(
    await fixtureImages.evaluateAll((images) =>
      images.map((image) => image.getAttribute('alt')),
    ),
  ).toEqual([late.title, middle.title, early.title]);
  for (const fixture of fixtures) {
    await picker
      .locator('.trip-gallery-options > div')
      .filter({
        has: page.getByRole('img', { name: fixture.title, exact: true }),
      })
      .getByRole('checkbox')
      .check();
  }
  await expect(
    picker.getByRole('img', { name: 'Synthetic incomplete draft' }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Raw pointer coordinates must target the editor after the modal unmounts.
  await expect(picker).toHaveCount(0);
  const gallery = page.getByRole('list', { name: 'Post gallery' });
  const tiles = gallery.locator('[data-gallery-id]');
  const ids = () =>
    tiles.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-gallery-id')),
    );
  await expect.poll(ids).toEqual([early.id, middle.id, late.id]);
  await gallery.locator('img').evaluateAll(async (images) =>
    Promise.all(
      images.map(async (image) => {
        if (image instanceof HTMLImageElement) await image.decode();
      }),
    ),
  );

  // Pointer drag commits on drop and can be cancelled without changing order.
  const viewportHeight = await page.evaluate(() => innerHeight);
  const handle = gallery.getByRole('button', {
    name: `Drag ${late.title} to reorder`,
  });
  await handle.scrollIntoViewIfNeeded();
  const source = await handle.boundingBox();
  const target = await gallery
    .locator(`[data-gallery-id="${early.id}"] img`)
    .boundingBox();
  if (!source || !target) throw new Error('Gallery drag bounds required');
  await page.mouse.move(source.x + 10, source.y + 10);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    Math.min(target.y + target.height / 2, viewportHeight - 60),
    { steps: 8 },
  );
  // A cancelled drag may legitimately scroll before Escape stops it.
  // Exercise that state before starting another real pointer interaction.
  const cancelScroll = await page.evaluate(() => scrollY);
  await page.mouse.move(source.x + 10, viewportHeight - 10, { steps: 8 });
  await expect
    .poll(() => page.evaluate(() => scrollY))
    .toBeGreaterThan(cancelScroll + 80);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await ids()).toEqual([early.id, middle.id, late.id]);
  // Cancellation stops scrolling; it does not restore the old page position.
  // Measure the next interaction from the current editor geometry.
  await handle.scrollIntoViewIfNeeded();
  const nextSource = await handle.boundingBox();
  const nextTarget = await gallery
    .locator(`[data-gallery-id="${early.id}"] img`)
    .boundingBox();
  if (!nextSource || !nextTarget)
    throw new Error('Current drag bounds required');
  await page.mouse.move(nextSource.x + 10, nextSource.y + 10);
  await page.mouse.down();
  await page.mouse.move(
    nextTarget.x + nextTarget.width / 2,
    nextTarget.y + nextTarget.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(ids).toEqual([late.id, early.id, middle.id]);

  // Touch uses the same pointer handlers, with the ordinary page scroll left on images.
  const touchHandle = gallery.getByRole('button', {
    name: `Drag ${early.title} to reorder`,
  });
  const touchTarget = await gallery
    .locator(`[data-gallery-id="${middle.id}"] img`)
    .boundingBox();
  if (!touchTarget) throw new Error('Touch target required');
  const touchSource = await touchHandle.boundingBox();
  if (!touchSource) throw new Error('Touch handle required');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: touchSource.x + 10, y: touchSource.y + 10 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: touchTarget.x + 20, y: touchTarget.y + 20 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
  await expect.poll(ids).toEqual([late.id, middle.id, early.id]);
  await gallery
    .getByRole('button', { name: `Move ${middle.title} earlier` })
    .focus();
  await page.keyboard.press('Enter');
  await expect.poll(ids).toEqual([middle.id, late.id, early.id]);
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /^published$/ }),
  ).toBeVisible();
  const editorUrl = page.url();
  const id = editorUrl.split('/').at(-1);
  if (!id) throw new Error('Saved post ID required');
  const saved = await page.request.get(`/api/trip/posts?id=${id}`);
  const savedPost = editorPostResponse.parse(await saved.json());
  expect(savedPost.data.gallery).toEqual([middle.id, late.id, early.id]);
  await page.reload();
  await expect.poll(ids).toEqual(savedPost.data.gallery);
  for (const fixture of fixtures) {
    const media = mediaResponse.parse(
      await (
        await page.request.get(`/_emdash/api/content/media_items/${fixture.id}`)
      ).json(),
    );
    expect(media.data.item.data.captured_at).toBe(fixture.captured_at);
    expect(media.data.item.data.latitude).toBe(35.6);
    expect(media.data.item.data.longitude).toBe(139.7);
  }
  const stale = await page.request.post('/api/trip/posts', {
    headers,
    data: { ...savedPost.data, id, revision: 'stale', publish: false },
  });
  expect(stale.status()).toBe(409);
  const anonymous = await browser.newContext({ baseURL });
  try {
    const denied = await anonymous.request.post('/api/trip/posts', {
      headers,
      data: {
        ...savedPost.data,
        id,
        revision: savedPost.revision,
        publish: false,
      },
    });
    expect(denied.status()).toBe(401);
  } finally {
    await anonymous.close();
  }
  await page.goto('/');
  const card = page
    .locator('article')
    .filter({ hasText: 'Synthetic ordered gallery' });
  await expect(card.locator('.media-tile')).toHaveCount(3);
  expect(
    await card
      .locator('.media-tile')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('aria-label')),
      ),
  ).toEqual([middle.title, late.title, early.title]);
  // Retain only allowlisted metadata, emitted only if the original transition fails.
  const nativePath = `/_emdash/admin/content/posts/${id}`;
  const origin = new URL(editorUrl).origin;
  const started = Date.now();
  const counts = { pageErrors: 0, consoleErrors: 0, requestFailures: 0 };
  const requests = new Map<
    Request,
    {
      label: string;
      startedMs: number;
      status: number | null;
      responseMs: number | null;
    }
  >();
  const onPageError = () => {
    counts.pageErrors++;
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') counts.consoleErrors++;
  };
  const onRequestFailure = () => {
    counts.requestFailures++;
  };
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET') return;
    const label = new Map([
      ['/_emdash/api/manifest', 'manifest'],
      ['/_emdash/api/auth/me', 'auth/me'],
      [`/_emdash/api/content/posts/${id}`, 'synthetic-post'],
    ]).get(url.pathname);
    if (label)
      requests.set(request, {
        label,
        startedMs: Date.now() - started,
        status: null,
        responseMs: null,
      });
  };
  const onResponse = (response: Response) => {
    const entry = requests.get(response.request());
    if (entry) {
      entry.status = response.status();
      entry.responseMs = Date.now() - started;
    }
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailure);
  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    await page.goto(editorUrl);
    // The client-only native app hydrates after document load. Complete its
    // post navigation before checking the rendered editor and gallery.
    const [nativePost] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.origin === origin &&
          url.pathname === `/_emdash/api/content/posts/${id}` &&
          response.request().method() === 'GET'
        );
      }),
      page.goto(nativePath),
    ]);
    expect(nativePost.status()).toBe(200);
    expect(savedResponse.parse(await nativePost.json()).data.item.id).toBe(id);
    await expect(page.locator('main h1')).toHaveText(
      'Synthetic ordered gallery',
    );
  } catch (error) {
    try {
      const elapsedMs = Date.now() - started;
      // Closed pages or interrupted execution must not replace the original error.
      const [bootLoader, headings] = await Promise.allSettled([
        page.getByText('Loading EmDash...', { exact: true }).isVisible(),
        page.locator('main h1').count(),
      ]);
      const finalUrl = new URL(page.url());
      const targetMatch =
        finalUrl.origin === origin && finalUrl.pathname === nativePath;
      const navigation =
        finalUrl.origin !== origin
          ? 'other-origin'
          : targetMatch
            ? 'native-editor'
            : finalUrl.pathname === new URL(editorUrl).pathname
              ? 'owner-editor'
              : /^\/_emdash\/(?:admin\/)?(?:login|auth)(?:\/|$)/.test(
                    finalUrl.pathname,
                  )
                ? 'auth'
                : 'other';
      console.log(
        'GALLERY_NATIVE_NAVIGATION_DIAGNOSTIC',
        JSON.stringify({
          elapsedMs,
          navigation,
          targetMatch,
          ...counts,
          bootLoaderVisible:
            bootLoader.status === 'fulfilled' ? bootLoader.value : null,
          mainH1Count: headings.status === 'fulfilled' ? headings.value : null,
          requests: [...requests.values()],
        }),
      );
    } catch {
      // Diagnostic collection must never replace the original failure.
    }
    throw error;
  } finally {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    page.off('requestfailed', onRequestFailure);
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
  const welcome = page
    .getByRole('dialog')
    .filter({ hasText: 'Welcome to EmDash' });
  if (await welcome.isVisible())
    await welcome.getByRole('button', { name: 'Get Started' }).click();
  await page.getByRole('button', { name: 'CHOOSE MEDIA', exact: true }).click();
  const nativePicker = page.getByRole('dialog');
  await expect(
    nativePicker
      .locator('label')
      .filter({ hasText: /^Synthetic gallery (late|middle|early)$/ }),
  ).toHaveText([late.title, middle.title, early.title]);
  for (const fixture of fixtures)
    await expect(
      nativePicker.getByRole('checkbox', { name: fixture.title, exact: true }),
    ).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(nativePicker).toHaveCount(0);
  const nativeGallery = page.getByRole('list', { name: 'Post gallery' });
  await expect(nativeGallery.locator('[data-gallery-id]')).toHaveCount(3);
  await nativeGallery
    .getByRole('button', { name: `Move ${early.title} earlier` })
    .click();
  expect(
    await nativeGallery
      .locator('[data-gallery-id]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-gallery-id')),
      ),
  ).toEqual([middle.id, early.id, late.id]);
  await expect
    .poll(
      async () =>
        editorPostResponse.parse(
          await (await page.request.get(`/api/trip/posts?id=${id}`)).json(),
        ).data.gallery,
    )
    .toEqual([middle.id, early.id, late.id]);
  const nativeHandle = nativeGallery.getByRole('button', {
    name: `Drag ${late.title} to reorder`,
  });
  await nativeHandle.scrollIntoViewIfNeeded();
  const nativeSource = await nativeHandle.boundingBox();
  const nativeTarget = await nativeGallery
    .locator(`[data-gallery-id="${middle.id}"] img`)
    .boundingBox();
  if (!nativeSource || !nativeTarget)
    throw new Error('Native drag bounds required');
  await page.mouse.move(nativeSource.x + 10, nativeSource.y + 10);
  await page.mouse.down();
  await page.mouse.move(nativeTarget.x + 20, nativeTarget.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        editorPostResponse.parse(
          await (await page.request.get(`/api/trip/posts?id=${id}`)).json(),
        ).data.gallery,
    )
    .toEqual([late.id, middle.id, early.id]);
});

for (const host of ['native', 'standalone']) {
  test(`${host} gallery drag scrolls down and up to offscreen targets and stops on cancellation`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('**/demo/*.jpg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"><rect width="200" height="400" fill="#dbe8ff"/><circle cx="100" cy="100" r="50" fill="#0647ff"/><text x="10" y="250" fill="#0647ff">synthetic photo</text></svg>',
      }),
    );
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
    await page.waitForURL('**/owner');
    const library = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            slug: z.string().nullable(),
            status: z.string(),
          }),
        ),
      })
      .parse(await (await page.request.get('/api/trip/media')).json());
    const selected = library.items
      .filter(
        (item) =>
          item.status === 'published' && /^demo-\d$/.test(item.slug || ''),
      )
      .map((item) => item.id);
    expect(selected).toHaveLength(9);
    const created = await page.request.post('/api/trip/posts', {
      headers: { 'X-EmDash-Request': '1', Origin: baseURL || '' },
      data: {
        title: `Synthetic ${host} autoscroll`,
        day: '2097-10-15',
        place: 'synthetic fixture',
        gallery: selected,
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Synthetic gallery drag fixture.' },
              ],
            },
          ],
        },
        publish: false,
      },
    });
    expect(created.ok()).toBe(true);
    const post = z
      .object({ post: editorPostResponse })
      .parse(await created.json()).post;
    await page.goto(
      host === 'native'
        ? `/_emdash/admin/content/posts/${post.id}`
        : `/owner/posts/${post.id}`,
    );
    if (host === 'native') {
      await expect(page.locator('main h1')).toHaveText(
        `Synthetic ${host} autoscroll`,
      );
      const welcome = page
        .getByRole('dialog')
        .filter({ hasText: 'Welcome to EmDash' });
      if (await welcome.isVisible())
        await welcome.getByRole('button', { name: 'Get Started' }).click();
      await expect(welcome).toHaveCount(0);
    }
    const gallery = page.getByRole('list', { name: 'Post gallery' });
    const tiles = gallery.locator('[data-gallery-id]');
    await expect(tiles).toHaveCount(9);
    await gallery.locator('img').evaluateAll(async (images) =>
      Promise.all(
        images.map(async (image) => {
          if (image instanceof HTMLImageElement) await image.decode();
        }),
      ),
    );
    const ids = () =>
      tiles.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-gallery-id')),
      );
    const readScroll = () =>
      gallery.evaluate(
        (element) =>
          element.closest('[data-emdash-editor-canvas]')?.scrollTop ?? scrollY,
      );
    const viewport = await gallery.evaluate((element) => {
      const panel = element.closest('[data-emdash-editor-canvas]');
      const bounds = panel?.getBoundingClientRect();
      return {
        top: bounds?.top ?? 0,
        bottom: bounds?.bottom ?? innerHeight,
        panel: Boolean(panel),
      };
    });
    expect(viewport.panel).toBe(host === 'native');
    const firstId = selected[0],
      lastId = selected.at(-1);
    if (!firstId || !lastId)
      throw new Error('First and last gallery items required');
    const firstTile = gallery.locator(`[data-gallery-id="${firstId}"]`);
    const lastTile = gallery.locator(`[data-gallery-id="${lastId}"]`);
    const firstHandle = firstTile.getByRole('button', { name: /^Drag / });
    await firstHandle.scrollIntoViewIfNeeded();
    expect(
      await lastTile.evaluate((element) => element.getBoundingClientRect().top),
    ).toBeGreaterThan(viewport.bottom);
    const downStart = await readScroll();
    const source = await firstHandle.boundingBox();
    if (!source) throw new Error('Drag handle bounds required');
    await page.mouse.move(source.x + 10, source.y + 10);
    await page.mouse.down();
    await page.mouse.move(source.x + 10, viewport.bottom - 10, { steps: 8 });
    await expect.poll(readScroll).toBeGreaterThan(downStart + 100);
    await expect
      .poll(() =>
        lastTile.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeLessThan(viewport.bottom - 100);
    const downTarget = await lastTile.locator('img').boundingBox();
    if (!downTarget) throw new Error('Offscreen target bounds required');
    await page.mouse.move(
      downTarget.x + 20,
      Math.max(
        viewport.top + 60,
        Math.min(viewport.bottom - 60, downTarget.y + 30),
      ),
    );
    await page.mouse.up();
    await expect.poll(ids).toEqual([...selected.slice(1), firstId]);
    if (host === 'native') expect(await page.evaluate(() => scrollY)).toBe(0);

    const movedHandle = firstTile.getByRole('button', { name: /^Drag / });
    await movedHandle.scrollIntoViewIfNeeded();
    const upStart = await readScroll();
    const upSource = await movedHandle.boundingBox();
    const topTile = tiles.first();
    expect(
      await topTile.evaluate((element) => element.getBoundingClientRect().top),
    ).toBeLessThan(viewport.top);
    if (!upSource) throw new Error('Upward drag handle required');
    await page.mouse.move(upSource.x + 10, upSource.y + 10);
    await page.mouse.down();
    await page.mouse.move(upSource.x + 10, viewport.top + 10, { steps: 8 });
    await expect.poll(readScroll).toBeLessThan(upStart - 100);
    await expect
      .poll(() =>
        topTile.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeGreaterThan(viewport.top - 20);
    const upTarget = await topTile.locator('img').boundingBox();
    if (!upTarget) throw new Error('Upward target required');
    await page.mouse.move(
      upTarget.x + 20,
      Math.max(viewport.top + 60, upTarget.y + 30),
    );
    await page.mouse.up();
    await expect.poll(ids).toEqual(selected);

    await firstHandle.scrollIntoViewIfNeeded();
    const cancelStart = await readScroll();
    const cancelSource = await firstHandle.boundingBox();
    if (!cancelSource) throw new Error('Cancellation handle required');
    await page.mouse.move(cancelSource.x + 10, cancelSource.y + 10);
    await page.mouse.down();
    await page.mouse.move(cancelSource.x + 10, viewport.bottom - 10, {
      steps: 8,
    });
    await expect.poll(readScroll).toBeGreaterThan(cancelStart + 80);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const stopped = await readScroll();
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++)
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            resolve();
          }),
        );
    });
    expect(await readScroll()).toBe(stopped);
    expect(await ids()).toEqual(selected);
    await expect(
      gallery.locator('[data-dragging="true"], [data-drop-target="true"]'),
    ).toHaveCount(0);
  });
}
