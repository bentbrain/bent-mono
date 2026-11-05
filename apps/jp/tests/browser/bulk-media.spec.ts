import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

const entry = z.object({
  data: z.object({
    _rev: z.string(),
    item: z.object({
      id: z.string(),
      status: z.string(),
      data: z.looseObject({ title: z.string() }),
    }),
  }),
});

for (const width of [1280, 390])
  test(`publish selected drafts together at ${String(width)}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/_emdash/api/setup/dev-bypass?redirect=/owner/media');
    await page.waitForURL('**/owner/media');
    const records: z.infer<typeof entry>['data']['item'][] = [];
    for (const title of ['sample first', 'sample second', 'sample untouched']) {
      const response = await page.request.post(
        '/_emdash/api/content/media_items',
        {
          headers: { Origin: baseURL || '', 'X-EmDash-Request': '1' },
          data: {
            slug: crypto.randomUUID(),
            data: {
              title,
              kind: 'photo',
              captured_at: '2099-10-15T01:23:45.678Z',
              latitude: 0,
              longitude: 139.6917,
              categories: [],
              source_url: '/demo/japan.jpg',
              demo: true,
            },
          },
        },
      );
      expect(response.status()).toBe(201);
      records.push(entry.parse(await response.json()).data.item);
    }
    await page.route('**/api/trip/media', async (route) => {
      const response = await route.fetch();
      const body = z
        .object({ items: z.array(z.looseObject({ id: z.string() })) })
        .parse(await response.json());
      await route.fulfill({
        response,
        json: {
          items: body.items.filter((item) =>
            records.some((record) => record.id === item.id),
          ),
        },
      });
    });
    await page.reload();
    await expect(page.locator('#media-list button')).toHaveCount(3);
    await page.getByRole('button', { name: 'SELECT', exact: true }).click();
    const publish = page.getByRole('button', { name: 'PUBLISH (0)' });
    await expect(publish).toBeDisabled();
    for (const title of ['sample first', 'sample second'])
      await page
        .getByRole('button', { name: `${title}, draft`, exact: true })
        .click();
    await expect(
      page.getByRole('button', { name: 'sample first, draft', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page
      .getByRole('button', { name: 'PUBLISH (2)', exact: true })
      .click();
    await expect(page.locator('#publish-status')).toHaveText('2 published');
    for (const record of records) {
      const response = await page.request.get(
        `/_emdash/api/content/media_items/${record.id}`,
      );
      const stored = entry.parse(await response.json()).data.item;
      expect(stored.status).toBe(
        record.data.title === 'sample untouched' ? 'draft' : 'published',
      );
      expect(stored.data).toEqual(record.data);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test('batch continues past invalid metadata and revision conflicts, then retries only failed drafts', async ({
  page,
  baseURL,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  const headers = { Origin: baseURL || '', 'X-EmDash-Request': '1' };
  const records: z.infer<typeof entry>['data'][] = [];
  for (const title of [
    'sample incomplete',
    'sample conflict',
    'sample valid',
    'sample published',
  ]) {
    const response = await page.request.post(
      '/_emdash/api/content/media_items',
      {
        headers,
        data: {
          slug: crypto.randomUUID(),
          data: {
            title,
            kind: 'photo',
            captured_at: '2099-10-15T01:23:45.678Z',
            latitude: 0,
            ...(title === 'sample incomplete' ? {} : { longitude: 139 }),
            categories: [],
            source_url: '/demo/japan.jpg',
            demo: true,
          },
        },
      },
    );
    expect(response.status()).toBe(201);
    records.push(entry.parse(await response.json()).data);
  }
  const alreadyPublished = records.find(
    (record) => record.item.data.title === 'sample published',
  );
  const conflict = records.find(
    (record) => record.item.data.title === 'sample conflict',
  );
  const incomplete = records.find(
    (record) => record.item.data.title === 'sample incomplete',
  );
  if (!alreadyPublished || !conflict || !incomplete)
    throw new Error('Sample records missing');
  expect(
    (
      await page.request.post(
        `/_emdash/api/content/media_items/${alreadyPublished.item.id}/publish`,
        { headers, data: { _rev: alreadyPublished._rev } },
      )
    ).status(),
  ).toBe(200);
  let refreshes = 0;
  await page.route('**/api/trip/media', async (route) => {
    refreshes++;
    const response = await route.fetch();
    const body = z
      .object({ items: z.array(z.looseObject({ id: z.string() })) })
      .parse(await response.json());
    await route.fulfill({
      response,
      json: {
        items: records.flatMap((record) =>
          body.items.filter((item) => item.id === record.item.id),
        ),
      },
    });
  });
  await page.reload();
  await expect(page.locator('#media-list button')).toHaveCount(4);
  const changed = await page.request.put(
    `/_emdash/api/content/media_items/${conflict.item.id}`,
    {
      headers,
      data: { _rev: conflict._rev, data: { place: 'sample changed metadata' } },
    },
  );
  expect(changed.status()).toBe(200);
  await page.getByRole('button', { name: 'SELECT', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: 'sample published, published',
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'SELECT ALL DRAFTS', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'PUBLISH (3)', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'CLEAR', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'PUBLISH (0)', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'SELECT ALL DRAFTS', exact: true })
    .click();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested: string[] = [];
  await page.route('**/media_items/*/publish', async (route) => {
    requested.push(route.request().url());
    await gate;
    await route.continue();
  });
  // Count only batch refreshes. A prior page mount can overlap the reload.
  refreshes = 0;
  const firstRequest = page.waitForRequest('**/media_items/*/publish');
  await page.getByRole('button', { name: 'PUBLISH (3)', exact: true }).click();
  await firstRequest;
  await expect(page.locator('#publish-status')).toHaveText('publishing 3 / 3');
  await expect(
    page.getByRole('button', { name: 'PUBLISHING', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'CANCEL', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'UPLOAD', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect.poll(() => requested.length).toBe(3);
  release();
  await expect(page.locator('#publish-status')).toHaveText(
    '1 published; 2 failed',
  );
  expect(requested).toHaveLength(3);
  expect(refreshes).toBe(1);
  await expect(
    page.getByRole('list', { name: 'publishing errors' }).getByRole('listitem'),
  ).toHaveCount(2);
  await expect(
    page.getByRole('list', { name: 'publishing errors' }),
  ).toContainText('capture time and valid coordinates');
  await expect(
    page.getByRole('button', { name: 'PUBLISH (2)', exact: true }),
  ).toBeEnabled();
  const latest = entry.parse(
    await (
      await page.request.get(
        `/_emdash/api/content/media_items/${incomplete.item.id}`,
      )
    ).json(),
  ).data;
  expect(
    (
      await page.request.put(
        `/_emdash/api/content/media_items/${incomplete.item.id}`,
        { headers, data: { _rev: latest._rev, data: { longitude: 139 } } },
      )
    ).status(),
  ).toBe(200);
  // Reload the corrected record before retrying the remaining drafts.
  await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'SELECT', exact: true }).click();
  await page
    .getByRole('button', { name: 'SELECT ALL DRAFTS', exact: true })
    .click();
  await page.getByRole('button', { name: 'PUBLISH (2)', exact: true }).click();
  await expect(page.locator('#publish-status')).toHaveText('2 published');
  expect(requested).toHaveLength(5);
  await expect(
    page.getByRole('list', { name: 'publishing errors' }),
  ).toHaveCount(0);
  for (const record of records) {
    const stored = entry.parse(
      await (
        await page.request.get(
          `/_emdash/api/content/media_items/${record.item.id}`,
        )
      ).json(),
    ).data;
    expect(stored.item.status).toBe('published');
    expect(stored.item.data.latitude).toBe(0);
    expect(stored.item.data.captured_at).toBe('2099-10-15T01:23:45.678Z');
  }
});

test('upload exits selection and later metadata saves keep batch publication', async ({
  page,
  baseURL,
}) => {
  await page.goto('/_emdash/api/setup/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  const created = await page.request.post('/_emdash/api/content/media_items', {
    headers: { Origin: baseURL || '', 'X-EmDash-Request': '1' },
    data: {
      slug: crypto.randomUUID(),
      data: {
        title: 'sample upload anchor',
        kind: 'photo',
        categories: [],
        source_url: '/demo/japan.jpg',
        demo: true,
      },
    },
  });
  expect(created.status()).toBe(201);
  await page.route('**/api/trip/media', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = z
      .object({
        items: z.array(
          z.looseObject({ data: z.looseObject({ title: z.string() }) }),
        ),
      })
      .parse(await response.json());
    await route.fulfill({
      response,
      json: {
        items: body.items.filter((item) =>
          item.data.title.startsWith('sample upload'),
        ),
      },
    });
  });
  await page.reload();
  await page.getByRole('button', { name: 'SELECT', exact: true }).click();
  await page
    .getByRole('button', { name: 'SELECT ALL DRAFTS', exact: true })
    .click();
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/trip/upload') &&
      response.request().method() === 'POST',
  );
  await page.locator('#upload').setInputFiles({
    name: 'sample upload photo.jpg',
    mimeType: 'image/jpeg',
    buffer: await readFile('public/demo/japan.jpg'),
  });
  const response = await uploaded;
  expect(response.status()).toBe(201);
  const id = z
    .object({ data: z.object({ item: z.object({ id: z.string() }) }) })
    .parse(await response.json()).data.item.id;
  await expect(page.locator('#upload-status')).toHaveText('uploaded');
  await expect(
    page.getByRole('button', { name: 'SELECT', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^PUBLISH \(/ })).toHaveCount(
    0,
  );
  await expect(page.locator('#metadata')).toBeVisible();
  await page.getByLabel('captured in japan').fill('2099-10-15T10:23:45.678');
  await page.getByLabel('latitude', { exact: true }).fill('0');
  await page.getByLabel('longitude', { exact: true }).fill('139');
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('saved');
  await page.getByRole('button', { name: 'SELECT', exact: true }).click();
  await expect(page.locator('#metadata')).toHaveCount(0);
  await page
    .getByRole('button', {
      name: 'sample upload photo.jpg, draft',
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: 'PUBLISH (1)', exact: true }).click();
  await expect(page.locator('#publish-status')).toHaveText('1 published');
  await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'sample upload photo.jpg, published',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'public', exact: true }),
  ).toBeChecked();
  await page.getByLabel('place', { exact: true }).fill('sample changed place');
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('saved');
  const stored = entry.parse(
    await (
      await page.request.get(`/_emdash/api/content/media_items/${id}`)
    ).json(),
  ).data.item;
  expect(stored.status).toBe('published');
  expect(stored.data.place).toBe('sample changed place');
  expect(stored.data.latitude).toBe(0);
  expect(stored.data.captured_at).toBe('2099-10-15T01:23:45.678Z');
});
