import { test, expect } from '@playwright/test';
import { z } from 'zod';

// All content and provider/status responses in this file are synthetic.
test('owner sees pending, unknown, failed and ready icons and makes explicit bounded retries', async ({
  page,
  baseURL,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  const created = await page.request.post('/_emdash/api/content/media_items', {
    headers: { Origin: baseURL || '', 'X-EmDash-Request': '1' },
    data: {
      slug: `icon-ui-${crypto.randomUUID()}`,
      data: {
        title: 'synthetic icon status',
        kind: 'photo',
        categories: ['ramen'],
        source_url: '/demo/japan.jpg',
        captured_at: '2026-10-15T10:00:00Z',
        latitude: 35,
        longitude: 139,
      },
    },
  });
  expect(created.status()).toBe(201);
  let state = 'pending';
  let permitted = false;
  const posted: unknown[] = [];
  await page.route('**/api/trip/category-icons', async (route) => {
    if (route.request().method() === 'POST') {
      posted.push(route.request().postDataJSON());
      state = 'pending';
      permitted = false;
      await route.fulfill({ json: { queued: true } });
    } else
      await route.fulfill({
        json: {
          icons: [
            { label: 'ramen', normalized: 'ramen', state, canRetry: permitted },
          ],
        },
      });
  });
  async function show(next: string, canRetry: boolean) {
    state = next;
    permitted = canRetry;
    await page.goto('/owner/media');
    await page
      .getByRole('button', {
        name: 'synthetic icon status, draft',
        exact: true,
      })
      .click();
  }
  await show('pending', false);
  const status = page.getByLabel('Category icons');
  await expect(status).toContainText('ramen icon · pending');
  await expect(status.getByRole('button')).toHaveCount(0);
  await show('uncertain', true);
  await expect(status).toContainText('result unknown; retry may charge again');
  await status
    .getByRole('button', { name: 'RETRY (MAY CHARGE)', exact: true })
    .click();
  await expect(status).toContainText('ramen icon · pending');
  expect(posted).toEqual([{ category: 'ramen', acknowledgeCharge: true }]);
  await show('failed', true);
  await status.getByRole('button', { name: 'RETRY', exact: true }).click();
  await expect(status).toContainText('pending');
  expect(posted[1]).toEqual({ category: 'ramen', acknowledgeCharge: false });
  await show('ready', true);
  await expect(status).toContainText('ramen icon · ready');
  await status.getByRole('button', { name: 'REGENERATE', exact: true }).click();
  await expect(status).toContainText('pending');
  await show('failed', false);
  await expect(status.getByRole('button')).toHaveCount(0);
  await show('setup', false);
  await expect(status).toContainText('add OPENAI_API_KEY');
  await expect(status.getByRole('button')).toHaveCount(0);
  await page.unroute('**/api/trip/category-icons');
});

test('custom category uses a stable themed fallback and public requests cannot enqueue', async ({
  page,
  baseURL,
}) => {
  const ownerStatusLoaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/trip/category-icons/provider') &&
      response.request().method() === 'GET',
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  // Finish the owner-only mount request before observing public navigation.
  await ownerStatusLoaded;
  const headers = { Origin: baseURL || '', 'X-EmDash-Request': '1' };
  const created = await page.request.post('/_emdash/api/content/media_items', {
    headers,
    data: {
      slug: `icon-fallback-${crypto.randomUUID()}`,
      data: {
        title: 'synthetic fallback',
        place: 'synthetic fixture',
        kind: 'photo',
        categories: ['synthetic noodles'],
        source_url: '/demo/japan.jpg',
        demo: true,
        captured_at: '2026-10-15T10:00:00Z',
        latitude: 35,
        longitude: 139,
      },
    },
  });
  expect(created.status()).toBe(201);
  const id = z
    .object({ data: z.object({ item: z.object({ id: z.string() }) }) })
    .parse(await created.json()).data.item.id;
  const current = z
    .object({ data: z.object({ _rev: z.string() }) })
    .parse(
      await (
        await page.request.get(`/_emdash/api/content/media_items/${id}`)
      ).json(),
    );
  const published = await page.request.post(
    `/_emdash/api/content/media_items/${id}/publish`,
    { headers, data: { _rev: current.data._rev } },
  );
  expect(published.status()).toBe(200);
  expect(await published.json()).toMatchObject({ success: true });
  const savedFixture: unknown = await (
    await page.request.get(`/_emdash/api/content/media_items/${id}`)
  ).json();
  expect(savedFixture).toMatchObject({
    data: {
      item: {
        status: 'published',
        data: { categories: ['synthetic noodles'] },
      },
    },
  });
  let ownerRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/trip/category-icons')) ownerRequests++;
  });
  await page.goto('/gallery');
  const link = page.getByRole('link', {
    name: 'synthetic noodles',
    exact: true,
  });
  const icon = link.locator('.category-icon');
  await expect(icon).toBeVisible();
  await expect(icon.locator('svg')).toBeVisible();
  const bounds = await icon.boundingBox();
  expect(bounds?.width).toBeCloseTo(22.09, 0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(icon).toHaveCSS('color', 'rgb(40, 112, 255)');
  await link.click();
  await expect(
    page.getByRole('link', { name: 'synthetic noodles', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page
      .getByRole('link', { name: 'synthetic noodles', exact: true })
      .locator('.category-icon'),
  ).toHaveCSS('color', 'rgb(0, 0, 0)');
  expect(ownerRequests).toBe(0);
});
