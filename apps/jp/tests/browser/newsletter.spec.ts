import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { newsletterJpeg } from '../../src/lib/newsletter-image';
import { newsletterStatusSchema } from '../../src/lib/newsletter-model';

const plugin = '/_emdash/api/plugins/japan-newsletter';
const colorSchemes: Array<'light' | 'dark'> = ['light', 'dark'];

// Keep the canonical coverage title while checking the requested homepage placement.
for (const width of [320, 390, 1280]) {
  test(`blog and pics share the whole bottom footer at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/', '/gallery']) {
      await page.goto(path);
      const signup = page.getByRole('region', { name: 'newsletter' });
      await expect(signup).toHaveCount(1);
      await expect(signup.getByRole('button')).toBeEnabled();
      await expect(
        page
          .getByRole('contentinfo')
          .getByRole('region', { name: 'newsletter' }),
      ).toHaveCount(path === '/' ? 0 : 1);
      if (path === '/') {
        await expect(signup).toBeInViewport();
        const signupBox = await signup.boundingBox();
        const mapBox = await page
          .getByRole('group', { name: 'Japan media map', exact: true })
          .boundingBox();
        if (!signupBox || !mapBox)
          throw new Error('Homepage signup and map required');
        expect(signupBox.y + signupBox.height).toBeLessThan(mapBox.y);
        await expect(
          page.getByRole('main').getByRole('region', { name: 'newsletter' }),
        ).toHaveCount(1);
      }
    }
  });
}

test('published uploaded photos reach the native image binding and stop serving when the post is unpublished', async ({
  page,
  browser,
  baseURL,
}) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  await page.request.post('/_emdash/api/setup/dev-bypass', {
    headers,
    data: {},
  });
  await page.request.get('/_emdash/api/auth/dev-bypass?redirect=/');
  const buffer = await readFile('public/demo/japan.jpg');
  const file = {
    name: 'synthetic-newsletter.jpg',
    mimeType: 'image/jpeg',
    buffer,
  };
  const uploaded = await page.request.post('/api/trip/upload', {
    headers,
    multipart: { original: file, display: file, poster: file },
  });
  expect(uploaded.status()).toBe(201);
  const media = z
    .object({
      data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
    })
    .parse(await uploaded.json()).data;
  const published = await page.request.patch('/api/trip/media', {
    headers,
    data: {
      id: media.item.id,
      revision: media._rev,
      publish: true,
      metadata: {
        title: 'synthetic newsletter photo',
        captured_at: '2026-10-15T20:15:00+09:00',
        latitude: 35.6895,
        longitude: 139.6917,
        place: 'synthetic location',
        categories: [],
      },
    },
  });
  expect(published.status()).toBe(200);
  const created = await page.request.post('/_emdash/api/content/posts', {
    headers,
    data: {
      slug: `synthetic-newsletter-${crypto.randomUUID()}`,
      data: {
        title: 'day 1: synthetic newsletter',
        day: '2026-10-15',
        gallery: [media.item.id],
      },
    },
  });
  expect(created.status()).toBe(201);
  const post = z
    .object({
      data: z.object({ item: z.object({ id: z.string() }), _rev: z.string() }),
    })
    .parse(await created.json()).data;
  expect(
    (
      await page.request.post(
        `/_emdash/api/content/posts/${post.item.id}/publish`,
        { headers, data: { _rev: post._rev } },
      )
    ).ok(),
  ).toBe(true);
  const owner = await page.request.get(`${plugin}/owner`, { headers });
  expect(owner.status()).toBe(200);
  const status = z
    .object({ data: newsletterStatusSchema })
    .parse(await owner.json()).data;
  const photo = status.posts.find((p) => p.id === post.item.id)?.images?.[0];
  expect(photo).toBeDefined();
  if (!photo) return;
  const anonymous = await browser.newContext({ baseURL });
  try {
    const image = await anonymous.request.get(photo.src);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/jpeg');
    expect(image.headers()['cache-control']).toContain('no-store');
    const bytes = Uint8Array.from(await image.body());
    const jpeg = newsletterJpeg(bytes);
    expect(bytes.length).toBeLessThanOrEqual(150_000);
    expect(jpeg.width).toBeLessThanOrEqual(1120);
    expect(jpeg.bytes).toEqual(bytes);
    expect(
      (
        await page.request.post(
          `/_emdash/api/content/posts/${post.item.id}/unpublish`,
          { headers },
        )
      ).ok(),
    ).toBe(true);
    expect((await anonymous.request.get(photo.src)).status()).toBe(404);
  } finally {
    await anonymous.close();
  }
});

test('public signup is accessible, reports unavailable transport honestly and blocks owner access', async ({
  page,
  baseURL,
}) => {
  await page.goto('/');
  const form = page.getByRole('region', {
    name: 'newsletter',
  });
  await expect(form).toBeVisible();
  await form
    .getByLabel('email', { exact: true })
    .fill('synthetic-reader@example.com');
  await form.getByRole('button', { name: 'SUBSCRIBE', exact: true }).click();
  await expect(form.getByRole('status')).toHaveText(
    'signups are temporarily unavailable. please try again later.',
  );
  expect(
    (
      await page.request.get(`${plugin}/owner`, {
        headers: { 'X-EmDash-Request': '1' },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await page.request.post(`${plugin}/manage`, {
        headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
        data: { action: 'test' },
      })
    ).status(),
  ).toBe(401);
  expect(
    (await page.request.get('/api/trip/newsletter-preview')).status(),
  ).toBe(401);
});

test('confirmation uses an explicit action, strips tokens from the address bar and disables caching', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`${plugin}/confirm`))
      requests.push(request.method());
  });
  const response = await page.goto(
    `/newsletter/confirm?token=${'a'.repeat(64)}`,
  );
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page).toHaveURL(/\/newsletter\/confirm$/);
  await expect(
    page.getByRole('button', { name: 'CONFIRM SUBSCRIPTION' }),
  ).toBeEnabled();
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'CONFIRM SUBSCRIPTION' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'this link has expired. please sign up again.',
  );
  expect(requests).toEqual(['POST']);
});

test('owner settings use private plugin storage, start paused and reject missing CSRF', async ({
  page,
  baseURL,
}) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  expect(
    (
      await page.request.post('/_emdash/api/setup/dev-bypass', {
        headers,
        data: {},
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/newsletter');
  await expect(
    page.getByRole('heading', { name: 'newsletter', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('automatic sending paused', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'day', exact: true }),
  ).toHaveText(/sunday/);
  await expect(
    page.getByRole('checkbox', { name: 'automatic sending' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'SEND ME A TEST' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: /^next digest/ }),
  ).toBeVisible();
  expect((await page.request.get(`${plugin}/owner`)).status()).toBe(403);
  const denied = await page.request.post(`${plugin}/manage`, {
    data: { action: 'test' },
  });
  expect(denied.status()).toBe(403);
  await page.getByRole('button', { name: 'SAVE SCHEDULE' }).click();
  await expect(page.getByRole('status')).toHaveText('schedule saved.');
  const response = await page.request.get('/api/trip/newsletter-preview');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-security-policy']).toContain(
    "default-src 'none'",
  );
  expect(response.headers()['cache-control']).toContain('no-store');
});

for (const path of ['/', '/gallery']) {
  for (const width of [320, 390, 1280]) {
    test(`newsletter stays above the shop on one line on ${path} at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      const signup = page.getByRole('region', { name: 'newsletter' });
      const email = signup.getByRole('textbox', { name: 'email', exact: true });
      const subscribe = signup.getByRole('button', {
        name: 'SUBSCRIBE',
        exact: true,
      });
      await expect(subscribe).toBeEnabled();
      // Other suites seed public posts. Keep this short-page fixture independent.
      await page
        .locator('.journal-grid > article, .pagination, .gallery-grid > *')
        .evaluateAll((entries) => {
          for (const entry of entries) entry.remove();
        });
      await expect(signup.getByRole('heading')).toHaveCount(0);
      await expect(signup.getByRole('link')).toHaveCount(0);
      await expect(signup.getByRole('status')).toBeEmpty();
      const labelBox = await signup
        .locator('label[for="newsletter-email"]')
        .boundingBox();
      expect(labelBox?.height).toBeLessThanOrEqual(1);
      const inputBox = await email.boundingBox();
      const buttonBox = await subscribe.boundingBox();
      const shopBox = await page
        .getByRole('link', { name: 'shop.bent.build ↗' })
        .boundingBox();
      const footer = page.getByRole('contentinfo');
      const footerBox = await footer.boundingBox();
      expect(inputBox).not.toBeNull();
      expect(buttonBox).not.toBeNull();
      expect(shopBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      if (!inputBox || !buttonBox || !shopBox || !footerBox) return;
      expect(inputBox.y).toBe(buttonBox.y);
      expect(inputBox.height).toBe(buttonBox.height);
      expect(inputBox.x + inputBox.width).toBeLessThan(buttonBox.x);
      expect(inputBox.x).toBe(shopBox.x);
      expect(buttonBox.x + buttonBox.width).toBe(shopBox.x + shopBox.width);
      expect(inputBox.y + inputBox.height).toBeLessThan(shopBox.y);
      await expect(
        footer.getByRole('link', { name: 'email privacy' }),
      ).toHaveAttribute('href', '/newsletter/privacy');
      expect(footerBox.y + footerBox.height).toBe(844);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    });
  }
}

for (const path of ['/', '/gallery', '/newsletter/privacy']) {
  for (const width of [320, 390, 1280]) {
    test(`shared signup has only accessible controls across its full width on ${path} at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      const signup = page.locator('[data-feedback-id="newsletter-signup"]');
      const email = signup.getByRole('textbox', { name: 'email', exact: true });
      const subscribe = signup.getByRole('button', {
        name: 'SUBSCRIBE',
        exact: true,
      });
      await expect(subscribe).toBeEnabled();
      await expect(signup.getByRole('heading')).toHaveCount(0);
      await expect(
        signup.getByText(
          'get new journal entries by email. unsubscribe anytime.',
          { exact: true },
        ),
      ).toHaveCount(0);
      await expect(signup.getByRole('status')).toBeEmpty();
      const label = signup.locator('label[for="newsletter-email"]');
      await expect(label).toHaveText('email');
      const labelBox = await label.boundingBox();
      await expect(signup).toHaveAccessibleName('newsletter');
      expect(
        await label.evaluate((element) => getComputedStyle(element).clipPath),
      ).toBe('inset(50%)');
      expect(labelBox?.height).toBeLessThanOrEqual(1);
      const inputBox = await email.boundingBox();
      const buttonBox = await subscribe.boundingBox();
      const formBox = await signup.locator('form').boundingBox();
      const signupBox = await signup.boundingBox();
      expect(inputBox).not.toBeNull();
      expect(buttonBox).not.toBeNull();
      expect(formBox).not.toBeNull();
      expect(signupBox).not.toBeNull();
      if (!inputBox || !buttonBox || !formBox || !signupBox) return;
      expect(inputBox.y).toBe(buttonBox.y);
      expect(inputBox.height).toBe(buttonBox.height);
      expect(inputBox.width).toBeGreaterThan(0);
      expect(inputBox.x + inputBox.width).toBeLessThan(buttonBox.x);
      expect(inputBox.x).toBe(formBox.x);
      expect(buttonBox.x + buttonBox.width).toBe(formBox.x + formBox.width);
      await expect(
        page
          .getByRole('contentinfo')
          .getByRole('region', { name: 'newsletter' }),
      ).toHaveCount(path === '/' ? 0 : 1);
      await expect(signup).toHaveCSS('padding', '0px');
      await expect(signup).toHaveCSS('border-top-width', '0px');
      expect(formBox.x).toBe(signupBox.x);
      expect(formBox.width).toBe(signupBox.width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      const privacy = page.getByRole('link', {
        name: 'email privacy',
        exact: true,
      });
      await expect(privacy).toHaveCount(1);
      await expect(privacy).toHaveAttribute('href', '/newsletter/privacy');
      await expect(signup.getByRole('link')).toHaveCount(0);
      await expect(
        page
          .getByRole('contentinfo')
          .getByRole('link', { name: 'email privacy' }),
      ).toBeVisible();
    });
  }
}

for (const path of ['/', '/gallery', '/newsletter/privacy']) {
  test(`signup validates email and preserves pending, confirmation and error feedback on ${path}`, async ({
    page,
  }) => {
    let submissions = 0;
    let finishResponse: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => {
      finishResponse = resolve;
    });
    await page.route(`${plugin}/subscribe`, async (route) => {
      submissions++;
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({
        email: 'synthetic-reader@example.com',
        website: '',
      });
      await responseReady;
      await route.fulfill({ json: { success: true, data: { ok: true } } });
    });
    await page.goto(path);
    const signup = page.getByRole('region', { name: 'newsletter' });
    const email = signup.getByRole('textbox', { name: 'email', exact: true });
    const subscribe = signup.getByRole('button', {
      name: 'SUBSCRIBE',
      exact: true,
    });
    await expect(subscribe).toBeEnabled();
    await subscribe.click();
    expect(submissions).toBe(0);
    await email.fill('invalid');
    await subscribe.click();
    expect(submissions).toBe(0);
    await email.fill('synthetic-reader@example.com');
    await subscribe.click();
    await expect(
      signup.getByRole('button', { name: 'SENDING…' }),
    ).toBeDisabled();
    await expect(email).toBeDisabled();
    finishResponse?.();
    await expect(signup.getByRole('status')).toHaveText(
      'check your inbox for a confirmation link.',
    );
    await expect(subscribe).toBeEnabled();
    await expect(email).toHaveValue('');
    expect(submissions).toBe(1);
    await page.route(`${plugin}/subscribe`, (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: 'signups are temporarily unavailable. please try again later.',
        },
      }),
    );
    await email.fill('synthetic-reader@example.com');
    await subscribe.click();
    await expect(signup.getByRole('status')).toHaveText(
      'signups are temporarily unavailable. please try again later.',
    );
    await expect(subscribe).toBeEnabled();
    await expect(email).toBeEnabled();
  });
}

for (const path of ['/', '/gallery', '/newsletter/privacy', '/404']) {
  for (const width of [320, 1280]) {
    for (const colorScheme of colorSchemes) {
      test(`shared footer reaches the page bottom on ${path} at ${String(width)}px in ${colorScheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme });
        await page.goto(path);
        await expect(
          page.getByRole('region', { name: 'newsletter' }).getByRole('button'),
        ).toBeEnabled();
        // Keep short pages independent of public content seeded by other suites.
        await page
          .locator('.journal-grid > article, .pagination, .gallery-grid > *')
          .evaluateAll((entries) => {
            for (const entry of entries) entry.remove();
          });
        const footer = page.getByRole('contentinfo');
        await expect(footer).toHaveCount(1);
        await expect(
          footer.getByRole('link', { name: 'email privacy', exact: true }),
        ).toHaveAttribute('href', '/newsletter/privacy');
        const box = await footer.boundingBox();
        expect(box).not.toBeNull();
        if (!box) return;
        const pageHeight = await page.evaluate(
          () => document.documentElement.scrollHeight,
        );
        expect(Math.round(box.y + box.height)).toBe(pageHeight);
        if (path !== '/newsletter/privacy') expect(pageHeight).toBe(844);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      });
    }

    test(`shared footer follows long content on ${path} at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      await page.locator('main').evaluate((main) => {
        const content = document.createElement('div');
        content.style.height = '1200px';
        content.textContent = 'synthetic layout fixture';
        main.append(content);
      });
      const footerBox = await page.getByRole('contentinfo').boundingBox();
      const mainBox = await page.locator('main').boundingBox();
      const signupBox = await page
        .getByRole('region', { name: 'newsletter' })
        .boundingBox();
      expect(footerBox).not.toBeNull();
      expect(mainBox).not.toBeNull();
      expect(signupBox).not.toBeNull();
      if (!footerBox || !mainBox || !signupBox) return;
      expect(footerBox.y).toBeGreaterThan(844);
      expect(footerBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height);
      expect(footerBox.y + footerBox.height).toBeGreaterThanOrEqual(
        signupBox.y + signupBox.height,
      );
      await page.getByRole('contentinfo').scrollIntoViewIfNeeded();
      await expect(
        page
          .getByRole('contentinfo')
          .getByRole('link', { name: 'email privacy' }),
      ).toBeVisible();
    });
  }
}
