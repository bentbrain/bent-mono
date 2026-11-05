import { test, expect, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
const createdSchema = z.object({
  data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
});
const run = crypto.randomUUID();
const media: { id: string; slug: string; shape: string }[] = [];
let postId = '';
let nativeId = '';
const postSlug = `synthetic-visibility-post-${run}`;
test.beforeAll(async ({ request, baseURL }) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  expect(
    (
      await request.post('/_emdash/api/setup/dev-bypass', { headers, data: {} })
    ).ok(),
  ).toBe(true);
  await request.get('/_emdash/api/auth/dev-bypass');
  async function create(
    collection: string,
    slug: string,
    data: Record<string, unknown>,
  ) {
    const response = await request.post(`/_emdash/api/content/${collection}`, {
      headers,
      data: { slug, data },
    });
    expect(response.status()).toBe(201);
    const { item, _rev } = createdSchema.parse(await response.json()).data;
    expect(
      (
        await request.post(
          `/_emdash/api/content/${collection}/${item.id}/publish`,
          { headers, data: { _rev } },
        )
      ).ok(),
    ).toBe(true);
    return item.id;
  }
  for (const shape of ['portrait', 'landscape', 'tall']) {
    const slug = `synthetic-visibility-${shape}-${run}`;
    const id = await create('media_items', slug, {
      title: `Synthetic visibility ${shape}`,
      kind: 'video',
      captured_at: '2099-10-15T00:00:00Z',
      latitude: 27.1,
      longitude: 128.4,
      place: 'synthetic visibility',
      categories: [],
      demo: true,
      duration: 6,
      source_url: `/demo/visibility-${shape}.mp4`,
      poster_url: `/demo/visibility-${shape}.svg`,
    });
    media.push({ id, slug, shape });
  }
  const bytes = await readFile(
    new URL('../fixtures/map-landscape.mp4', import.meta.url),
  );
  const poster = await readFile('public/demo/japan.jpg');
  const uploaded = await request.post('/api/trip/upload', {
    headers,
    multipart: {
      original: {
        name: 'synthetic-native.mp4',
        mimeType: 'video/mp4',
        buffer: bytes,
      },
      display: {
        name: 'synthetic-native.mp4',
        mimeType: 'video/mp4',
        buffer: bytes,
      },
      poster: {
        name: 'synthetic-poster.jpg',
        mimeType: 'image/jpeg',
        buffer: poster,
      },
    },
  });
  expect(uploaded.status()).toBe(201);
  nativeId = z
    .object({ data: z.object({ item: z.object({ id: z.string() }) }) })
    .parse(await uploaded.json()).data.item.id;
  const currentSchema = z.object({
    data: z.object({
      _rev: z.string(),
      item: z.object({
        data: z.object({
          asset: z.object({ id: z.string() }),
          source_url: z.string(),
        }),
      }),
    }),
  });
  const current = currentSchema.parse(
    await (
      await request.get(`/_emdash/api/content/media_items/${nativeId}`)
    ).json(),
  ).data;
  const updated = await request.put(
    `/_emdash/api/content/media_items/${nativeId}`,
    {
      headers,
      data: {
        _rev: current._rev,
        data: {
          title: 'Synthetic native video',
          captured_at: '2099-10-15T00:00:00Z',
          latitude: 27.1,
          longitude: 128.4,
          place: 'synthetic visibility',
          categories: [],
          demo: true,
        },
      },
    },
  );
  expect(updated.ok()).toBe(true);
  const revision = currentSchema.parse(
    await (
      await request.get(`/_emdash/api/content/media_items/${nativeId}`)
    ).json(),
  ).data._rev;
  expect(
    (
      await request.post(
        `/_emdash/api/content/media_items/${nativeId}/publish`,
        { headers, data: { _rev: revision } },
      )
    ).ok(),
  ).toBe(true);
  postId = await create('posts', postSlug, {
    title: 'Synthetic visibility post',
    day: '2099-10-15',
    content: [
      {
        _type: 'video',
        _key: 'synthetic-visibility-inline',
        asset: {
          _ref: current.item.data.asset.id,
          url: current.item.data.source_url,
        },
      },
    ],
    gallery: media.map((item) => item.id),
    demo: true,
  });
});
test.beforeEach(async ({ page }) => {
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.route('**/demo/visibility-*.svg', (route) => {
    const portrait = !route.request().url().includes('landscape');
    const tall = route.request().url().includes('tall');
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? '160' : '240'}" height="${tall ? '480' : portrait ? '240' : '160'}"><rect width="100%" height="100%" fill="#0647ff"/><text x="8" y="80" fill="white">synthetic video</text></svg>`,
    });
  });
  await page.route('**/demo/visibility-*.mp4', async (route) => {
    const shape = route.request().url().includes('tall')
      ? 'tall'
      : route.request().url().includes('portrait')
        ? 'portrait'
        : 'landscape';
    const body = await readFile(
      new URL(`../fixtures/map-${shape}.mp4`, import.meta.url),
    );
    const header = route.request().headers()['range'];
    const range = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
    const suffix = range?.[1] === '' && range[2] !== '';
    const start = suffix
      ? Math.max(0, body.length - Number(range[2]))
      : Number(range?.[1] || 0);
    const end = suffix
      ? body.length - 1
      : Math.min(Number(range?.[2] || body.length - 1), body.length - 1);
    if (start > end || start >= body.length) {
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
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL || '' };
  if (postId)
    expect(
      (
        await request.delete(`/_emdash/api/content/posts/${postId}`, {
          headers,
        })
      ).ok(),
    ).toBe(true);
  if (nativeId)
    expect(
      (
        await request.delete(`/_emdash/api/content/media_items/${nativeId}`, {
          headers,
        })
      ).ok(),
    ).toBe(true);
  for (const item of media)
    expect(
      (
        await request.delete(`/_emdash/api/content/media_items/${item.id}`, {
          headers,
        })
      ).ok(),
    ).toBe(true);
});
async function state(video: Locator) {
  return video.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement))
      throw new Error('Video required');
    return {
      paused: element.paused,
      time: element.currentTime,
      muted: element.muted,
      loop: element.loop,
      error: element.error?.code ?? null,
    };
  });
}
test('media viewer stays paused offscreen and starts muted when scrolled into view', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes('/demo/visibility-') &&
      request.url().includes('.mp4')
    )
      requests.push(request.url());
  });
  const item = media[0];
  if (!item) throw new Error('Fixture required');
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () =>
      document
        .querySelector('.viewer')
        ?.setAttribute('style', 'margin-top:1200px;margin-bottom:1200px'),
    );
  });
  await page.goto(`/media/${item.slug}`);
  const video = page.locator('.viewer video');
  await expect(video).toHaveCount(1);
  expect((await state(video)).paused).toBe(true);
  // Allow the browser's speculative loader a chance to fetch hidden metadata.
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
  await video.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await state(video)).paused).toBe(false);
  await expect.poll(async () => (await state(video)).time).toBeGreaterThan(0.2);
  expect((await state(video)).muted).toBe(true);
  expect(requests.length).toBeGreaterThan(0);
});

async function moving(video: Locator) {
  await expect.poll(async () => (await state(video)).paused).toBe(false);
  const time = (await state(video)).time;
  await expect.poll(async () => (await state(video)).time).not.toBe(time);
  expect((await state(video)).error).toBeNull();
}
async function stopped(video: Locator) {
  await expect.poll(async () => (await state(video)).paused).toBe(true);
  const time = (await state(video)).time;
  // Observe a real wall-clock interval; a paused flag alone misses pending plays.
  await video.page().waitForTimeout(350);
  expect((await state(video)).paused).toBe(true);
  expect((await state(video)).time).toBeCloseTo(time, 2);
}
for (const width of [390, 1280]) {
  test(`public viewer loops, pauses offscreen and respects manual controls at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const item of media) {
      await page.goto(`/media/${item.slug}`);
      const video = page.locator('.viewer video');
      await video.scrollIntoViewIfNeeded();
      await moving(video);
      expect((await state(video)).muted).toBe(true);
      expect((await state(video)).loop).toBe(true);
      await video.evaluate((element) => {
        if (element instanceof HTMLVideoElement)
          element.currentTime = element.duration - 0.3;
      });
      await expect.poll(async () => (await state(video)).time).toBeLessThan(1);
      await moving(video);
      await video.press('Space');
      await stopped(video);
      await video.evaluate((element) => {
        const box = element.getBoundingClientRect();
        scrollBy(0, box.top + box.height * 0.55);
      });
      await stopped(video);
      await video.scrollIntoViewIfNeeded();
      await stopped(video);
      await video.evaluate((element) => {
        if (element instanceof HTMLVideoElement) {
          element.muted = false;
          element.currentTime = 2;
        }
      });
      await video.press('Space');
      await moving(video);
      expect((await state(video)).muted).toBe(false);
      // Add room to scroll the complete viewer out of view without replacing it.
      await page.locator('.viewer').evaluate((element) => {
        if (element instanceof HTMLElement)
          element.style.marginBottom = '1600px';
      });
      await page.evaluate(() => {
        scrollTo(0, document.body.scrollHeight);
      });
      await stopped(video);
      await video.scrollIntoViewIfNeeded();
      await moving(video);
      expect((await state(video)).muted).toBe(true);
      await video.evaluate((element) => {
        element.remove();
      });
    }
  });
  test(`carousel selection and clipped public galleries pause inactive video at ${String(width)}px`, async ({
    page,
  }) => {
    const requested = new Set<string>();
    page.on('request', (request) => {
      if (
        request.url().includes('/demo/visibility-') &&
        request.url().includes('.mp4')
      )
        requested.add(new URL(request.url()).pathname);
    });
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/']) {
      await page.goto(path);
      const carousel =
        path === '/'
          ? page
              .locator('article')
              .filter({
                has: page.getByRole('link', {
                  name: 'Synthetic visibility post',
                  exact: true,
                }),
              })
              .locator('.post-carousel')
          : page.locator('.post-carousel');
      const videos = carousel.locator('video');
      await expect(videos).toHaveCount(3);
      await videos.first().scrollIntoViewIfNeeded();
      await moving(videos.first());
      await stopped(videos.nth(1));
      if (process.env.VIDEO_LOADING_EVIDENCE) {
        await videos.first().evaluate((element) => {
          if (element instanceof HTMLVideoElement) {
            element.pause();
            element.currentTime = 0;
          }
        });
        await page.evaluate(() => document.fonts.ready);
        await carousel.screenshot({
          path: join(
            process.env.VIDEO_LOADING_EVIDENCE,
            `carousel-${String(width)}.png`,
          ),
          animations: 'disabled',
        });
      }
      expect(requested).toEqual(new Set(['/demo/visibility-portrait.mp4']));
      await carousel.getByRole('button', { name: 'Next slide' }).click();
      await videos.nth(1).scrollIntoViewIfNeeded();
      await moving(videos.nth(1));
      await stopped(videos.first());
      expect(requested).toEqual(
        new Set([
          '/demo/visibility-portrait.mp4',
          '/demo/visibility-landscape.mp4',
        ]),
      );
      await carousel.getByRole('button', { name: 'Previous slide' }).click();
      await videos.first().scrollIntoViewIfNeeded();
      await moving(videos.first());
      await stopped(videos.nth(1));
    }
  });
  test(`gallery video tiles retain playback and viewer navigation at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/gallery');
    for (const item of media) {
      const video = page.getByLabel(`Synthetic visibility ${item.shape}`, {
        exact: true,
      });
      await video.scrollIntoViewIfNeeded();
      await moving(video);
      expect((await state(video)).muted).toBe(true);
      await expect(
        page.getByRole('link', {
          name: `View Synthetic visibility ${item.shape}`,
          exact: true,
        }),
      ).toHaveAttribute('href', `/media/${item.slug}`);
    }
  });
}

test('document visibility boundary pauses and resumes silently without undoing a manual pause', async ({
  page,
}) => {
  const item = media[0];
  if (!item) throw new Error('Fixture required');
  await page.goto(`/media/${item.slug}`);
  const video = page.locator('.viewer video');
  await moving(video);
  async function hidden(value: boolean) {
    await page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
  }
  await hidden(true);
  await stopped(video);
  await hidden(false);
  await moving(video);
  expect((await state(video)).muted).toBe(true);
  await video.press('Space');
  await stopped(video);
  await hidden(true);
  await hidden(false);
  await stopped(video);
});

test('blocked autoplay retains native manual playback without unhandled rejection', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'play',
    );
    if (!descriptor) throw new Error('Native play descriptor required');
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      Object.defineProperty(HTMLMediaElement.prototype, 'play', descriptor);
      return Promise.reject(
        new DOMException('Synthetic autoplay block', 'NotAllowedError'),
      );
    };
  });
  const item = media[0];
  if (!item) throw new Error('Fixture required');
  await page.goto(`/media/${item.slug}`);
  const video = page.locator('.viewer video');
  await stopped(video);
  await expect(video).toHaveAttribute('controls', '');
  await video.press('Space');
  await moving(video);
  expect(errors).toEqual([]);
});

test('pending automatic play cannot restart an offscreen or removed video', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'play',
    );
    if (!descriptor) throw new Error('Native play descriptor required');
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      Object.defineProperty(HTMLMediaElement.prototype, 'play', descriptor);
      this.setAttribute('data-pending-play', 'true');
      return new Promise<void>((resolve, reject) => {
        this.addEventListener(
          'release-pending-play',
          () => {
            // Pausing before the first bytes arrive legitimately aborts play.
            // Both completion paths must settle before testing the stopped clock.
            void this.play()
              .then(resolve, reject)
              .finally(() => {
                this.setAttribute('data-pending-play', 'settled');
              });
          },
          { once: true },
        );
      });
    };
  });
  const item = media[0];
  if (!item) throw new Error('Fixture required');
  await page.goto(`/media/${item.slug}`);
  const video = page.locator('.viewer video');
  await expect(video).toHaveAttribute('data-pending-play', 'true');
  await page.locator('.viewer').evaluate((element) => {
    if (element instanceof HTMLElement) element.style.marginBottom = '1600px';
  });
  await page.evaluate(() => {
    scrollTo(0, document.body.scrollHeight);
  });
  await expect
    .poll(() =>
      video.evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBeLessThanOrEqual(0);
  // Settle the pending request before measuring the completed pause. The
  // initial paused flag is also true while that request has not started yet.
  await video.dispatchEvent('release-pending-play');
  await expect(video).toHaveAttribute('data-pending-play', 'settled');
  await stopped(video);
  await video.scrollIntoViewIfNeeded();
  await moving(video);
  const handle = await video.elementHandle();
  await video.evaluate((element) => {
    element.remove();
  });
  await expect
    .poll(() =>
      handle.evaluate(
        (element) => element instanceof HTMLVideoElement && element.paused,
      ),
    )
    .toBe(true);
  await handle.dispose();
  await page.goto(`/media/${item.slug}`);
  await expect(video).toHaveAttribute('data-pending-play', 'true');
  const pending = await video.elementHandle();
  await video.evaluate((element) => {
    element.remove();
  });
  await pending.evaluate((element) => {
    element.dispatchEvent(new Event('release-pending-play'));
  });
  await expect
    .poll(() => pending.getAttribute('data-pending-play'))
    .toBe('settled');
  await expect
    .poll(() =>
      pending.evaluate(
        (element) => element instanceof HTMLVideoElement && element.paused,
      ),
    )
    .toBe(true);
  const time = await pending.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement))
      throw new Error('Video required');
    return element.currentTime;
  });
  await page.waitForTimeout(400);
  expect(
    await pending.evaluate(
      (element) => element instanceof HTMLVideoElement && element.paused,
    ),
  ).toBe(true);
  expect(
    await pending.evaluate((element) => {
      if (!(element instanceof HTMLVideoElement))
        throw new Error('Video required');
      return element.currentTime;
    }),
  ).toBeCloseTo(time, 2);
  await pending.dispose();
});

test('a tall portrait stays bounded in the post mosaic and plays without cropping', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto(`/posts/${postSlug}`);
  const video = page.locator('.post-mosaic video').nth(2);
  await video.scrollIntoViewIfNeeded();
  await moving(video);
  const dimensions = await video.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement))
      throw new Error('Video required');
    const box = element.getBoundingClientRect();
    return {
      height: box.height,
      viewport: innerHeight,
      ratio: element.videoWidth / element.videoHeight,
    };
  });
  expect(dimensions.height).toBeLessThanOrEqual(
    (dimensions.viewport * 70) / 100,
  );
  expect(dimensions.ratio).toBeCloseTo(1 / 3, 2);
  await expect(video).toHaveCSS('object-fit', 'contain');
  expect((await state(video)).muted).toBe(true);
});

test('owner layouts and unrelated preview videos do not join public playback', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
  await page.waitForURL('**/owner');
  await expect(page.locator('body')).not.toHaveAttribute(
    'data-public-video-playback',
  );
  await page.evaluate(() => {
    const video = document.createElement('video');
    video.setAttribute('aria-label', 'Synthetic owner preview');
    video.src = '/demo/visibility-portrait.mp4';
    video.controls = true;
    video.setAttribute('data-visibility-video', '');
    document.body.prepend(video);
  });
  const preview = page.getByLabel('Synthetic owner preview');
  await stopped(preview);
  expect((await state(preview)).muted).toBe(false);
  expect((await state(preview)).loop).toBe(false);
});

test('native rich-text public video joins the shared controller without a second media element', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto(`/posts/${postSlug}`);
  const video = page.locator('.rich-text .emdash-video video');
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute('preload', 'none');
  await video.scrollIntoViewIfNeeded();
  await moving(video);
  expect((await state(video)).muted).toBe(true);
  expect((await state(video)).loop).toBe(true);
  // Native controls remain usable without the visibility controller or React.
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const fallback = await context.newPage();
    await fallback.goto(`/media/${nativeId}`);
    const player = fallback.locator('.viewer video');
    await expect(player).toHaveAttribute('controls', '');
    await expect(player).toHaveAttribute('preload', 'none');
    expect((await state(player)).paused).toBe(true);
    await player.press('Space');
    await moving(player);
    await player.press('Space');
    await stopped(player);
  } finally {
    await context.close();
  }
});

for (const target of ['video', 'ancestor']) {
  test(`CSS visibility on ${target} stops previously unmuted playback and returns silently`, async ({
    page,
  }) => {
    const item = media[0];
    if (!item) throw new Error('Fixture required');
    await page.goto(`/media/${item.slug}`);
    const video = page.locator('.viewer video');
    await moving(video);
    await video.evaluate((element) => {
      if (element instanceof HTMLVideoElement) element.muted = false;
    });
    await video.evaluate((element, target) => {
      const hidden = target === 'video' ? element : element.closest('.viewer');
      if (!(hidden instanceof HTMLElement))
        throw new Error('Visibility target required');
      hidden.style.visibility = 'hidden';
    }, target);
    expect(
      await video.evaluate((element) => getComputedStyle(element).visibility),
    ).toBe('hidden');
    await stopped(video);
    await video.evaluate((element, target) => {
      const hidden = target === 'video' ? element : element.closest('.viewer');
      if (hidden instanceof HTMLElement) hidden.style.visibility = '';
    }, target);
    await moving(video);
    expect((await state(video)).muted).toBe(true);
  });
}

async function delayFirstPlay(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'play',
    );
    if (!descriptor) throw new Error('Native play descriptor required');
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      Object.defineProperty(HTMLMediaElement.prototype, 'play', descriptor);
      this.setAttribute('data-pending-review-play', 'true');
      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          void this.play().then(resolve, reject);
        }, 300);
      });
    };
  });
}

test('pending playback moved outside the controlled root stays paused while still connected', async ({
  page,
}) => {
  await delayFirstPlay(page);
  const item = media[0];
  if (!item) throw new Error('Fixture required');
  await page.goto(`/media/${item.slug}`);
  const video = page.locator('.viewer video');
  await expect(video).toHaveAttribute('data-pending-review-play', 'true');
  const handle = await video.elementHandle();
  await video.evaluate((element) => {
    document.documentElement.append(element);
  });
  await page.waitForTimeout(650);
  expect(
    await handle.evaluate(
      (element) => element.isConnected && !document.body.contains(element),
    ),
  ).toBe(true);
  expect(
    await handle.evaluate(
      (element) => element instanceof HTMLVideoElement && element.paused,
    ),
  ).toBe(true);
  const time = await handle.evaluate((element) =>
    element instanceof HTMLVideoElement ? element.currentTime : -1,
  );
  await page.waitForTimeout(350);
  expect(
    await handle.evaluate((element) =>
      element instanceof HTMLVideoElement ? element.currentTime : -1,
    ),
  ).toBeCloseTo(time, 2);
  await handle.dispose();
});

test('CSS class and root-ancestor visibility honor an explicitly visible child', async ({
  page,
}) => {
  const item = media[0];
  if (!item) throw new Error('Fixture required');
  await page.goto(`/media/${item.slug}`);
  const video = page.locator('.viewer video');
  await moving(video);
  await page.addStyleTag({
    content: '.synthetic-hidden-video { visibility:hidden }',
  });
  await page.locator('.viewer').evaluate((element) => {
    element.classList.add('synthetic-hidden-video');
  });
  await stopped(video);
  await page.locator('.viewer').evaluate((element) => {
    element.classList.remove('synthetic-hidden-video');
  });
  await moving(video);
  expect((await state(video)).muted).toBe(true);
  await video.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement))
      throw new Error('Video required');
    element.muted = false;
    element.style.visibility = 'visible';
    element.closest('.viewer')?.classList.add('synthetic-hidden-video');
  });
  expect(
    await video.evaluate((element) => getComputedStyle(element).visibility),
  ).toBe('visible');
  await moving(video);
  expect((await state(video)).muted).toBe(false);
  await video.evaluate((element) => {
    if (element instanceof HTMLElement) element.style.visibility = '';
  });
  await stopped(video);
  await page.locator('.viewer').evaluate((element) => {
    element.classList.remove('synthetic-hidden-video');
  });
  await moving(video);
  await page.evaluate(() => {
    document.documentElement.style.visibility = 'hidden';
  });
  await stopped(video);
  await page.evaluate(() => {
    document.documentElement.style.visibility = '';
  });
  await moving(video);
  expect((await state(video)).muted).toBe(true);
});

test('same-root movement and replacement registration survive a retired pending play', async ({
  page,
}) => {
  const item = media[0];
  if (!item) throw new Error('Fixture required');
  await page.goto(`/media/${item.slug}`);
  const video = page.locator('.viewer video');
  await moving(video);
  await video.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement))
      throw new Error('Video required');
    element.muted = false;
    const parent = element.parentElement;
    if (!parent) throw new Error('Parent required');
    const wrapper = document.createElement('div');
    parent.prepend(wrapper);
    wrapper.append(element);
  });
  await moving(video);
  expect((await state(video)).muted).toBe(false);
  const removed = await video.elementHandle();
  await video.evaluate((element) => {
    element.remove();
  });
  await expect
    .poll(() =>
      removed.evaluate(
        (element) => element instanceof HTMLVideoElement && element.paused,
      ),
    )
    .toBe(true);
  await removed.evaluate((element) => {
    document.querySelector('.viewer')?.append(element);
  });
  await moving(video);
  expect((await state(video)).muted).toBe(true);
  await removed.dispose();

  await delayFirstPlay(page);
  await page.goto(`/media/${item.slug}`);
  await expect(video).toHaveAttribute('data-pending-review-play', 'true');
  const pending = await video.elementHandle();
  await video.evaluate((element) => {
    document.documentElement.append(element);
  });
  await page.waitForTimeout(50);
  await pending.evaluate((element) => {
    document.querySelector('.viewer')?.append(element);
  });
  await moving(video);
  await page.waitForTimeout(400);
  await moving(video);
  expect((await state(video)).muted).toBe(true);
  await video.press('Space');
  await stopped(video);
  await video.press('Space');
  await moving(video);
  await pending.dispose();
});
