import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Input, BufferSource, ALL_FORMATS } from 'mediabunny';
import { z } from 'zod';
import { measurePublicFooter } from '../fixtures/footer-geometry';
const run = promisify(execFile);

async function expectSystemTheme(page: Page, scheme: 'light' | 'dark') {
  await expect(page.locator('body')).toHaveCSS(
    'background-color',
    scheme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)',
  );
  await expect(page.locator('body')).toHaveCSS(
    'color',
    scheme === 'dark' ? 'rgb(40, 112, 255)' : 'rgb(6, 71, 255)',
  );
  await expect(page.locator('html')).toHaveCSS('color-scheme', scheme);
  if (new URL(page.url()).pathname === '/') {
    await expect(
      page.locator('#japan-map svg[aria-label="Japan media map"] > path'),
    ).toHaveCSS(
      'fill',
      scheme === 'dark' ? 'rgb(11, 19, 41)' : 'rgb(255, 255, 255)',
    );
  }
}

const systemThemes: ('light' | 'dark')[] = ['light', 'dark'];
for (const initial of systemThemes) {
  test(`blog follows initial ${initial} and live OS theme changes on every route`, async ({
    page,
  }) => {
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
    await page.waitForURL('**/owner');
    const editRoute = await page
      .locator('a[href^="/owner/posts/"]:not([href$="/new"])')
      .first()
      .getAttribute('href');
    if (!editRoute) throw new Error('Seeded post editor route required');
    const opposite = initial === 'dark' ? 'light' : 'dark';
    const liveThemes: ('light' | 'dark')[] = [opposite, initial];
    for (const route of [
      '/',
      '/gallery',
      '/posts/tokyo-after-dark',
      '/media/demo-0',
      '/404',
      '/owner',
      '/owner/media',
      '/owner/export',
      '/owner/posts/new',
      editRoute,
    ]) {
      await page.emulateMedia({ colorScheme: initial });
      const response = await page.goto(route);
      expect(response?.status()).toBe(route === '/404' ? 404 : 200);
      expect(new URL(page.url()).pathname).toBe(route);
      await expectSystemTheme(page, initial);
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      for (const scheme of liveThemes) {
        await page.emulateMedia({ colorScheme: scheme });
        await expectSystemTheme(page, scheme);
        if (route === '/owner/posts/new') {
          await expect(page.getByLabel('title', { exact: true })).toHaveCSS(
            'color-scheme',
            scheme,
          );
        }
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(
          timeOrigin,
        );
      }
    }
  });
}

test('public themes follow the OS with JavaScript disabled', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    colorScheme: 'dark',
  });
  try {
    const page = await context.newPage();
    for (const route of [
      '/',
      '/gallery',
      '/posts/tokyo-after-dark',
      '/media/demo-0',
      '/404',
    ]) {
      await page.emulateMedia({ colorScheme: 'dark' });
      const response = await page.goto(route);
      expect(response?.status()).toBe(route === '/404' ? 404 : 200);
      expect(new URL(page.url()).pathname).toBe(route);
      await expectSystemTheme(page, 'dark');
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      await page.emulateMedia({ colorScheme: 'light' });
      await expectSystemTheme(page, 'light');
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(
        timeOrigin,
      );
    }
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ page }) => {
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
});
test('shared layout installs the toolbar once and keeps owner content private', async ({
  page,
}) => {
  await page.goto('/');
  const embed = page.locator(
    'script[src="https://toolbar.bent.build/embed.js"]',
  );
  await expect(embed).toHaveCount(1);
  await expect(embed).toHaveAttribute('data-project', 'prj_0000000000000000');
  await expect(page.locator('main')).not.toHaveAttribute(
    'data-feedback-private',
  );
  await expect(page.locator('main')).not.toHaveAttribute(
    'data-feedback-redact',
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await expect(embed).toHaveCount(1);
  await expect(page.locator('main')).toHaveAttribute('data-feedback-private');
  await expect(page.locator('main')).toHaveAttribute('data-feedback-redact');
  await page.getByRole('button', { name: 'LINK', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) => Boolean(element.closest('main'))),
  ).toBe(false);
  expect(
    await dialog.evaluate((element) =>
      Boolean(element.closest('[data-feedback-redact]')),
    ),
  ).toBe(true);
});
test('individual post media stays inline with direct photo links', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/posts/tokyo-after-dark');
  const mosaic = page.locator('.post-mosaic');
  await expect(mosaic.locator('.media-tile')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Next slide' })).toHaveCount(0);
  for (const photo of await mosaic.locator('a.media-tile').all()) {
    await expect(photo).toHaveAttribute('href', /^\/media\//);
    await photo.scrollIntoViewIfNeeded();
    await expect(photo).toBeInViewport();
  }
});
test('post mosaic preserves video playback and keyboard controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/posts/tokyo-after-dark');
  const video = page.locator('.post-mosaic video').first();
  await video.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      video.evaluate(
        (element) => element instanceof HTMLVideoElement && !element.paused,
      ),
    )
    .toBe(true);
  await video.press('Space');
  await expect
    .poll(() =>
      video.evaluate(
        (element) => element instanceof HTMLVideoElement && element.paused,
      ),
    )
    .toBe(true);
  await video.press('Space');
  await expect
    .poll(async () =>
      video.evaluate((el) => el instanceof HTMLVideoElement && !el.paused),
    )
    .toBe(true);
  expect(
    await video.evaluate((el) => {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
});
test('owner attaches, recolours and removes a shop design', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await page.getByLabel('title', { exact: true }).fill('Shop design post');
  await page
    .getByRole('textbox', { name: 'Post content' })
    .fill('A design from today.');
  await page.getByRole('button', { name: '+ MEDIA', exact: true }).click();
  const mediaPicker = page.getByRole('dialog');
  for (const index of [0, 1, 2]) {
    await mediaPicker
      .getByRole('checkbox', { name: 'gallery', exact: true })
      .nth(index)
      .check();
  }
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: 'add shop design' }).check();
  await page
    .getByLabel('product link')
    .fill(
      'https://shop.bent.build/featured/3d8ed467-55d4-45ed-ba9d-1eeb687fa5bc',
    );
  await page.getByRole('button', { name: 'BLACK', exact: true }).click();
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('published');
  const editorUrl = page.url();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'BLACK', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/');
  const card = page.locator('article').filter({ hasText: 'Shop design post' });
  await expect(card.locator('.post-media > *')).toHaveCount(4);
  await expect(card.locator('.post-media > :last-child')).toHaveClass(
    /post-design-slide/,
  );
  await expect(card.getByRole('button', { name: 'Next slide' })).toBeEnabled();
  for (let index = 0; index < 3; index++)
    await card.getByRole('button', { name: 'Next slide' }).click();
  await expect(card.getByText('4 / 4', { exact: true })).toBeVisible();
  await expect(card.locator('.post-design-link')).toBeInViewport();
  await expect(card.locator('.post-design img')).toHaveAttribute(
    'src',
    /\/black\.webp\?/,
  );
  await expect(card.locator('.post-design-link')).toHaveAttribute(
    'href',
    /Color=Black/,
  );
  await card
    .getByRole('link', { name: 'Shop design post', exact: true })
    .click();
  const postUrl = page.url();
  await expect(page.locator('.post-design img')).toHaveAttribute(
    'src',
    /\/black\.webp\?/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const mosaic = page.locator('.post-mosaic');
  await expect(mosaic.locator('.media-tile')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Next slide' })).toHaveCount(0);
  const shopLink = mosaic.locator('.post-design-link');
  await shopLink.scrollIntoViewIfNeeded();
  await expect(shopLink).toBeInViewport();
  expect(
    await mosaic.locator('.post-design img').evaluate((el) => el.closest('a')),
  ).toBeNull();
  await expect(mosaic.locator('.post-design').getByRole('link')).toHaveCount(1);
  const designBox = await mosaic.locator('.post-design').boundingBox();
  const articleBox = await page.locator('.single-post').boundingBox();
  if (!designBox || !articleBox) throw new Error('Post design required');
  expect(designBox.x).toBeGreaterThanOrEqual(articleBox.x);
  expect(designBox.x + designBox.width).toBeLessThanOrEqual(
    articleBox.x + articleBox.width,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(editorUrl);
  await page.getByRole('button', { name: 'WHITE', exact: true }).click();
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('published');
  await page.goto(postUrl);
  await expect(page.locator('.post-design img')).toHaveAttribute(
    'src',
    /\/white\.webp\?/,
  );
  await page.goto(editorUrl);
  await page.getByRole('checkbox', { name: 'add shop design' }).uncheck();
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('published');
  await page.reload();
  await expect(
    page.getByRole('checkbox', { name: 'add shop design' }),
  ).not.toBeChecked();
  await page.goto(postUrl);
  await expect(page.locator('.post-design')).toHaveCount(0);
});
test.beforeAll(async ({ request }) => {
  await request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1', Origin: 'http://127.0.0.1:4391' },
    data: {},
  });
  await run('bun', ['demo'], {
    env: { ...process.env, TEST_BASE_URL: 'http://127.0.0.1:4391' },
  });
});
for (const width of [320, 1280]) {
  test(`published post and media routes share the privacy footer at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/posts/tokyo-after-dark', '/media/demo-0']) {
      expect((await page.goto(path))?.status()).toBe(200);
      const privacy = page.getByRole('link', {
        name: 'email privacy',
        exact: true,
      });
      await expect(privacy).toHaveCount(1);
      await expect(
        page
          .getByRole('contentinfo')
          .getByRole('link', { name: 'email privacy' }),
      ).toHaveAttribute('href', '/newsletter/privacy');
      const signup = page
        .getByRole('contentinfo')
        .getByRole('region', { name: 'newsletter' });
      await expect(signup).toHaveCSS('padding', '0px');
      await expect(signup).toHaveCSS('border-top-width', '0px');
      const {
        signup: signupBox,
        shop: shopBox,
        footer: footerBox,
        scrollHeight,
        scrollWidth,
      } = await measurePublicFooter(page);
      expect(shopBox.y - signupBox.y - signupBox.height).toBe(24);
      expect(shopBox.x).toBe(signupBox.x);
      expect(shopBox.width).toBe(signupBox.width);
      expect(Math.round(footerBox.y + footerBox.height)).toBe(scrollHeight);
      expect(scrollWidth).toBe(width);
    }
  });
}
test('journal has map first, full text and playable video', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.journal-grid > :first-child')).toHaveClass(
    /journal-map-card/,
  );
  await expect(
    page.getByText(
      'Spent the evening walking through Shinjuku. Stopped for dinner, then kept walking.',
    ),
  ).toBeVisible();
  await expect(page.locator('.post-media video').first()).toHaveAttribute(
    'controls',
    '',
  );
  await page.locator('.map-marker').first().click();
  await expect(page.locator('.map-detail')).toBeVisible();
  expect(
    await page
      .getByRole('button', { name: 'Close map preview' })
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBe(44);
  await page.getByRole('button', { name: 'Close map preview' }).click();
  await expect(page.locator('.map-detail')).toBeHidden();
});
test('mobile galleries keep bounded horizontal post media without page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/gallery');
  const columns = await page
    .locator('.gallery-grid')
    .evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
    );
  expect(columns).toBe(1);
  await page.goto('/');
  expect(
    await page
      .locator('.post-media')
      .first()
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  expect(
    await page
      .locator('.post-media')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(320);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('exports require owner auth and PNG has story dimensions', async ({
  page,
}, info) => {
  const denied = await page.request.post('/api/trip/story', {
    data: { day: '2026-10-15', ids: [], counter: 'total' },
  });
  expect(denied.status()).toBe(401);
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/export');
  await page.waitForURL('**/owner/export');
  await expect(page.locator('#story-preview canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'card angle' }).click();
  await page.getByRole('option', { name: 'no skew' }).click();
  await expect(page.getByRole('combobox', { name: 'card angle' })).toHaveText(
    /no skew/,
  );
  await expect(page.locator('#story-preview canvas')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'EXPORT PNG' }).click();
  const file = await download,
    path = info.outputPath('story.png');
  await file.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  expect(bytes.readUInt32BE(16)).toBe(1080);
  expect(bytes.readUInt32BE(20)).toBe(1920);
});
test('rich editor exposes the published trip media picker', async ({
  page,
}) => {
  const fixtures = [
    { id: 'old', captured_at: '2026-10-14T10:00:00+09:00' },
    { id: 'tie-b', captured_at: '2026-10-15T01:00:00Z' },
    { id: 'new', captured_at: '2026-10-17T01:00:00Z' },
    { id: 'tie-a', captured_at: '2026-10-15T10:00:00+09:00' },
  ].map(({ id, captured_at }) => ({
    id,
    status: 'published',
    _rev: 'synthetic',
    data: {
      title: `Synthetic picker ${id}`,
      kind: id === 'tie-b' ? 'video' : 'photo',
      captured_at,
      asset: { id: `asset-${id}`, url: '/synthetic-picker.svg' },
    },
  }));
  await page.route('**/api/trip/media', (route) =>
    route.fulfill({
      json: {
        items: [
          ...fixtures,
          {
            id: 'draft',
            status: 'draft',
            _rev: 'synthetic',
            data: { title: 'Synthetic incomplete draft' },
          },
        ],
      },
    }),
  );
  await page.route('**/synthetic-picker.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#0647ff"/></svg>',
    }),
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await page.getByRole('button', { name: '+ MEDIA', exact: true }).click();
  const picker = page.getByRole('dialog');
  await expect(picker.locator('.trip-gallery-field')).toBeVisible();
  await expect(picker.locator('img')).toHaveCount(4);
  await expect(picker.locator('img').first()).toBeVisible();
  expect(
    await picker
      .locator('img')
      .evaluateAll((images) =>
        images.map((image) => image.getAttribute('alt')),
      ),
  ).toEqual(
    ['new', 'tie-a', 'tie-b', 'old'].map((id) => `Synthetic picker ${id}`),
  );
  const choice = (id: string) =>
    picker
      .locator('.trip-gallery-options > div')
      .filter({
        has: page.getByRole('img', {
          name: `Synthetic picker ${id}`,
          exact: true,
        }),
      })
      .getByRole('checkbox');
  for (const id of ['new', 'old']) await choice(id).check();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  const gallery = page.getByRole('list', { name: 'Post gallery' });
  expect(
    await gallery
      .locator('[data-gallery-id]')
      .evaluateAll((tiles) =>
        tiles.map((tile) => tile.getAttribute('data-gallery-id')),
      ),
  ).toEqual(['old', 'new']);
  await page.getByRole('button', { name: '+ MEDIA', exact: true }).click();
  await expect(choice('new')).toBeChecked();
  await expect(choice('old')).toBeChecked();
  await choice('old').uncheck();
  await expect(choice('new')).toBeChecked();
});
test('MP4 story export contains a portrait AVC video track', async ({
  page,
}, info) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/export');
  await page.waitForURL('**/owner/export');
  await expect(page.locator('#story-preview canvas')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'EXPORT MP4' }).click();
  const file = await download,
    path = info.outputPath('story.mp4');
  await file.saveAs(path);
  const input = new Input({
    source: new BufferSource(await readFile(path)),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    expect(await track?.getCodec()).toBe('avc');
    expect(await track?.getDisplayWidth()).toBe(1080);
    expect(await track?.getDisplayHeight()).toBe(1920);
    expect(await input.computeDuration()).toBeCloseTo(8);
  } finally {
    input.dispose();
  }
});

test('owner writes and publishes rich text through the shadcn editor', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await page.getByLabel('title', { exact: true }).fill('Browser post');
  await page
    .getByRole('textbox', { name: 'Post content' })
    .fill('A real published paragraph.');
  await page.getByRole('textbox', { name: 'Post content' }).press('Enter');
  await page.getByRole('textbox', { name: 'Post content' }).press('Enter');
  await page.keyboard.type('After the blank paragraph.');
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('published');
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Post content' }),
  ).toContainText('After the blank paragraph.');
  await expect(
    page.getByRole('textbox', { name: 'Post content' }).locator('p'),
  ).toHaveCount(3);
  await page.goto('/');
  await expect(page.getByText('A real published paragraph.')).toBeVisible();
});

test('draft posts stay available to the owner and hidden from the journal', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await page
    .getByLabel('title', { exact: true })
    .fill('Unpublished browser draft');
  await page
    .getByRole('textbox', { name: 'Post content' })
    .fill('Private draft paragraph.');
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  await page.goto('/owner');
  await expect(
    page.getByRole('row').filter({ hasText: 'Unpublished browser draft' }),
  ).toContainText('draft');
  await page.goto('/');
  await expect(page.getByText('Private draft paragraph.')).toBeHidden();
});

test('a delayed save keeps newer edits unsaved', async ({ page }) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await page.getByLabel('title', { exact: true }).fill('Delayed save');
  const editor = page.getByRole('textbox', { name: 'Post content' });
  await editor.fill('Submitted text');
  let releaseResponse = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/api/trip/posts', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'SAVE DRAFT', exact: true }),
  ).toBeDisabled();
  await editor.fill('Newer unsaved text');
  releaseResponse();
  await expect(
    page.getByRole('button', { name: 'SAVE DRAFT', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await expect(page.getByRole('status')).toContainText('newer edits unsaved');
  await page.unroute('**/api/trip/posts');
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  await page.reload();
  await expect(editor).toHaveText('Newer unsaved text');
});

test('owner uploads a photo and publishes it with manual GPS and categories', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  await expect(
    page.getByRole('button', { name: 'UPLOAD', exact: true }),
  ).toBeEnabled();
  await page.locator('#upload').setInputFiles('public/demo/japan.jpg');
  await expect(page.locator('#upload-status')).toHaveText('uploaded', {
    timeout: 30_000,
  });
  await expect(page.locator('#metadata')).toBeVisible();
  await page.getByLabel('title', { exact: true }).fill('Browser upload photo');
  await page.getByLabel('captured in japan').fill('2026-10-15T20:15');
  await page.getByLabel('latitude', { exact: true }).fill('35.6895');
  await page.getByLabel('longitude', { exact: true }).fill('139.6917');
  await page.getByRole('checkbox', { name: 'food', exact: true }).check();
  await page
    .locator('#metadata')
    .getByRole('button', { name: 'NEW CATEGORY', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('name', { exact: true })
    .fill('ramen');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'CREATE', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: 'ramen', exact: true }),
  ).toBeChecked();
  await page.getByRole('checkbox', { name: 'public', exact: true }).check();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('saved');
  await page.goto('/gallery?category=ramen');
  await expect(
    page.getByRole('img', { name: 'Browser upload photo', exact: true }),
  ).toBeVisible();
  await page.goto('/owner/posts/new');
  await page.getByLabel('title', { exact: true }).fill('Photo publication');
  await page.getByRole('textbox', { name: 'Post content' }).fill('Dinner');
  await page.getByRole('button', { name: 'LIST', exact: true }).click();
  await page.getByRole('button', { name: '+ MEDIA', exact: true }).click();
  const uploadedTile = page.locator('.trip-gallery-options > div').filter({
    has: page.getByRole('img', { name: 'Browser upload photo', exact: true }),
  });
  await uploadedTile
    .getByRole('button', { name: 'INSERT IN POST', exact: true })
    .click();
  await expect(page.locator('.tiptap img')).toHaveAttribute(
    'src',
    /^\/_emdash\/api\/media\/file\/trip\//,
  );
  await expect(page.locator('.tiptap li img')).toHaveCount(0);
  await expect(page.locator('.tiptap > img')).toHaveCount(1);
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('published');
  await page.goto('/');
  await expect(
    page
      .locator('article')
      .filter({ hasText: 'Photo publication' })
      .getByRole('img', { name: 'Browser upload photo', exact: true }),
  ).toBeVisible();
});

test('category-only edits retain capture seconds and milliseconds', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  await expect(
    page.getByRole('button', { name: 'UPLOAD', exact: true }),
  ).toBeEnabled();
  const captured = '2026-10-15T11:15:42.123Z';
  const created = await page.request.post('/_emdash/api/content/media_items', {
    headers: { 'X-EmDash-Request': '1', Origin: 'http://127.0.0.1:4391' },
    data: {
      slug: `capture-precision-${crypto.randomUUID()}`,
      data: {
        title: 'Capture precision',
        kind: 'photo',
        captured_at: captured,
        latitude: 35.6895,
        longitude: 139.6917,
        categories: ['food'],
        source_url: '/demo/japan.jpg',
      },
    },
  });
  expect(created.ok()).toBe(true);
  const id = z
    .object({ data: z.object({ item: z.object({ id: z.string() }) }) })
    .parse(await created.json()).data.item.id;
  await page.reload();
  await page
    .getByRole('button', { name: 'Capture precision, draft', exact: true })
    .click();
  await page.getByRole('checkbox', { name: 'shopping', exact: true }).check();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('saved');
  const saved = await page.request.get(
    `/_emdash/api/content/media_items/${id}`,
  );
  const metadata = z
    .object({
      data: z.object({
        item: z.object({
          data: z.object({
            captured_at: z.string(),
            latitude: z.number(),
            longitude: z.number(),
            categories: z.array(z.string()),
          }),
        }),
      }),
    })
    .parse(await saved.json()).data.item.data;
  expect(metadata.categories).toContain('shopping');
  expect(metadata.captured_at).toBe(captured);
  expect(metadata.latitude).toBe(35.6895);
  expect(metadata.longitude).toBe(139.6917);
  await expect(page.locator('#metadata time')).toHaveAttribute(
    'datetime',
    captured,
  );
  await expect(
    page.locator(
      '#metadata input[name="captured"],#metadata input[name="latitude"],#metadata input[name="longitude"]',
    ),
  ).toHaveCount(0);
  await page
    .getByLabel('place', { exact: true })
    .fill('synthetic changed place');
  const secondSave = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/trip/media') &&
      response.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await secondSave;
  await expect(page.locator('#save-status')).toHaveText('saved');
  const edited = await page.request.get(
    `/_emdash/api/content/media_items/${id}`,
  );
  expect(
    z
      .object({
        data: z.object({
          item: z.object({
            data: z.object({
              captured_at: z.string(),
              latitude: z.number(),
              longitude: z.number(),
              place: z.string(),
            }),
          }),
        }),
      })
      .parse(await edited.json()).data.item.data,
  ).toEqual({
    captured_at: captured,
    latitude: 35.6895,
    longitude: 139.6917,
    place: 'synthetic changed place',
  });
});

test('cancelling PNG export during loading or saving prevents a download', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/export');
  await page.waitForURL('**/owner/export');
  await expect(page.locator('#story-preview canvas')).toBeVisible();
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  for (const phase of ['loading', 'saving']) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pattern =
      phase === 'loading' ? '**/demo/*.jpg' : '**/api/trip/exports';
    await page.route(pattern, async (route) => {
      await gate;
      await route.continue().catch(() => {});
    });
    const pending = page.waitForRequest(
      phase === 'loading' ? /\/demo\/.*\.jpg/ : /\/api\/trip\/exports$/,
    );
    await page.getByRole('button', { name: 'EXPORT PNG', exact: true }).click();
    await pending;
    await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
    release();
    await expect(page.locator('#export-status')).toHaveText('cancelled');
    expect(downloads).toBe(0);
    await expect(page.locator('#download')).toHaveCount(0);
    await page.unroute(pattern);
  }
});
