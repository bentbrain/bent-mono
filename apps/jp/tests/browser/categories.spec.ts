import { test, expect } from '@playwright/test';
import { categoryCollectionSchema } from '../../src/lib/category-collection-model';

test('categories persist independently of media, normalize duplicates and are selectable after reload', async ({
  page,
  baseURL,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/categories');
  await page.waitForURL('**/categories');
  const name = `sample category ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'NEW CATEGORY', exact: true }).click();
  await page.getByRole('dialog').getByLabel('name', { exact: true }).fill(name);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'CREATE', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Saved categories')).toContainText(name);
  await page.reload();
  await expect(page.getByLabel('Saved categories')).toContainText(name);
  const headers = { Origin: baseURL || '', 'X-EmDash-Request': '1' };
  const duplicate = await page.request.post('/api/trip/categories', {
    headers,
    data: { name: ` ${name.toUpperCase()} ` },
  });
  expect(duplicate.status()).toBe(200);
  const state = categoryCollectionSchema.parse(await duplicate.json());
  expect(
    state.categories.filter((item) => item.normalized === name),
  ).toHaveLength(1);
  const schema = await page.request.get(
    '/_emdash/api/schema/collections/categories?includeFields=true',
  );
  expect(schema.status()).toBe(200);
  const icons = await page.request.get(
    '/_emdash/api/schema/collections/category_icons?includeFields=true',
  );
  expect(icons.status()).toBe(200);
  expect(await icons.text()).toContain('image');
  await page.goto('/owner/media');
  await expect(page.getByLabel('other categories')).toHaveCount(0);
  const created = await page.request.post('/_emdash/api/content/media_items', {
    headers,
    data: {
      slug: `sample-dynamic-${crypto.randomUUID()}`,
      data: {
        title: name,
        kind: 'photo',
        categories: [name],
        source_url: '/demo/japan.jpg',
        captured_at: '2026-10-15T10:00:00Z',
        latitude: 35,
        longitude: 139,
        demo: true,
      },
    },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await page
    .getByRole('button', { name: `${name}, draft`, exact: true })
    .click();
  await expect(page.getByRole('checkbox', { name, exact: true })).toBeChecked();
  await page.getByLabel('title', { exact: true }).fill('sample unsaved title');
  let metadataWrites = 0;
  page.on('request', (request) => {
    if (
      request.url().endsWith('/api/trip/media') &&
      request.method() === 'PATCH'
    )
      metadataWrites++;
  });
  await page
    .locator('#metadata')
    .getByRole('button', { name: 'NEW CATEGORY', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('name', { exact: true })
    .fill(`${name} b`);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'CREATE', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: `${name} b`, exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel('title', { exact: true })).toHaveValue(
    'sample unsaved title',
  );
  expect(metadataWrites).toBe(0);
});

test('category tools require the owner and reject forged creation requests', async ({
  page,
  browser,
  baseURL,
}) => {
  const anonymous = await browser.newContext();
  const denied = await anonymous.request.get('/api/trip/categories');
  expect(denied.status()).toBe(401);
  const privatePage = await anonymous.request.get('/categories', {
    maxRedirects: 0,
  });
  expect(privatePage.status()).toBe(302);
  expect(
    (
      await anonymous.request.get(
        `/api/trip/icon-library/${'a'.repeat(64)}/${'b'.repeat(64)}.png`,
      )
    ).status(),
  ).toBe(401);
  await anonymous.close();
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/categories');
  await page.waitForURL('**/categories');
  expect(
    (
      await page.request.post('/api/trip/categories', {
        data: { name: 'forged category' },
      })
    ).status(),
  ).toBe(403);
  const invalid = await page.request.post('/api/trip/categories', {
    headers: { Origin: baseURL || '', 'X-EmDash-Request': '1' },
    data: { name: '\u200B' },
  });
  expect(invalid.status()).toBe(400);
});

for (const path of ['/categories', '/owner/media']) {
  test(`failed category creation recovers a cancelled initial query on ${path}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
    await page.waitForURL('**/owner');
    if (path === '/owner/media') {
      const created = await page.request.post(
        '/_emdash/api/content/media_items',
        {
          headers: { Origin: baseURL || '', 'X-EmDash-Request': '1' },
          data: {
            slug: crypto.randomUUID(),
            data: {
              title: 'sample category recovery photo',
              kind: 'photo',
              categories: [],
              source_url: '/demo/japan.jpg',
              captured_at: '2099-10-15T01:23:45.678Z',
              latitude: 0,
              longitude: 139,
              demo: true,
            },
          },
        },
      );
      expect(created.status()).toBe(201);
    }
    let loads = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/trip/categories', async (route) => {
      if (route.request().method() === 'POST')
        return route.fulfill({
          status: 503,
          json: { error: 'sample category creation failed' },
        });
      const requestNumber = ++loads;
      const response = await route.fetch();
      if (requestNumber === 1) await gate;
      try {
        await route.fulfill({ response });
      } catch (error) {
        if (!route.request().failure()) throw error;
      }
    });
    try {
      await page.goto(path);
      await expect.poll(() => loads).toBe(1);
      await page
        .getByRole('button', { name: 'NEW CATEGORY', exact: true })
        .click();
      const dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('name', { exact: true })
        .fill('sample failed category');
      await dialog.getByRole('button', { name: 'CREATE', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText(
        'sample category creation failed',
      );
      release();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => loads).toBe(2);
      if (path === '/categories') {
        await expect(
          page.getByText('loading categories', { exact: true }),
        ).toHaveCount(0);
        await expect(page.getByLabel('Saved categories')).toContainText('food');
        await page.screenshot({
          path: '/tmp/japan-pr57-category-loading-recovered.png',
        });
      } else {
        await page
          .getByRole('button', {
            name: 'sample category recovery photo, draft',
            exact: true,
          })
          .click();
        await expect(
          page.getByRole('checkbox', { name: 'food', exact: true }),
        ).toBeVisible();
      }
    } finally {
      release();
    }
  });
}
