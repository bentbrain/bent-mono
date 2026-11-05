import { test, expect } from '@playwright/test';
import { z } from 'zod';

const savedBeer = z.object({
  data: z.object({
    item: z.object({
      id: z.string(),
      status: z.string(),
      data: z.object({ day: z.string(), count: z.number() }),
    }),
    _rev: z.string(),
  }),
});

test('owner updates the existing beer day when its day field differs from its slug', async ({
  page,
  baseURL,
}) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  const setup = await page.request.post('/_emdash/api/setup/dev-bypass', {
    headers,
    data: {},
  });
  expect(setup.ok()).toBe(true);
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
  await page.waitForURL('**/owner');
  const schema = await page.request.put(
    '/_emdash/api/schema/collections/beers/fields/day',
    { headers, data: { indexed: true } },
  );
  expect(schema.ok()).toBe(true);
  for (const path of ['/api/trip/beers', '/_emdash/api/content/beers']) {
    const warmed = await page.request.get(path);
    expect(warmed.status()).toBeLessThan(500);
  }
  const created = await page.request.post('/_emdash/api/content/beers', {
    headers,
    timeout: 10000,
    data: {
      slug: '2099-10-17',
      data: { title: 'sample beer day', day: '2099-10-16', count: 1 },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const fixture = savedBeer.parse(await created.json()).data;
  const id = fixture.item.id;
  const published = await page.request.post(
    `/_emdash/api/content/beers/${id}/publish`,
    { headers, data: { _rev: fixture._rev } },
  );
  expect(published.ok()).toBe(true);
  await page.getByLabel('Beer day', { exact: true }).fill('2099-10-17');
  await page.getByLabel('Daily beers', { exact: true }).fill('2');
  const saving = page.waitForResponse('**/api/trip/beers');
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  const saved = await saving;
  expect(saved.ok(), await saved.text()).toBe(true);
  await expect(page.getByRole('status')).toHaveText('saved');
  const stored = await page.request.get(`/_emdash/api/content/beers/${id}`);
  const updated = savedBeer.parse(await stored.json()).data.item;
  expect(updated).toMatchObject({
    id,
    status: 'published',
    data: { day: '2099-10-17', count: 2 },
  });

  // Existing date slugs must also work when the legacy field is not indexed.
  const unindexed = await page.request.put(
    '/_emdash/api/schema/collections/beers/fields/day',
    { headers, data: { indexed: false } },
  );
  expect(unindexed.ok()).toBe(true);
  try {
    for (const count of [0, 2]) {
      const saved = await page.request.post('/api/trip/beers', {
        headers,
        data: { day: '2099-10-17', count },
      });
      expect(saved.ok(), await saved.text()).toBe(true);
      expect(savedBeer.parse(await saved.json()).data.item).toMatchObject({
        id,
        status: 'published',
        data: { day: '2099-10-17', count },
      });
    }
  } finally {
    const restored = await page.request.put(
      '/_emdash/api/schema/collections/beers/fields/day',
      { headers, data: { indexed: true } },
    );
    expect(restored.ok()).toBe(true);
    const deleted = await page.request.delete(
      `/_emdash/api/content/beers/${id}`,
      { headers },
    );
    expect(deleted.ok()).toBe(true);
  }
});

test('beer saves preserve entries with older non-date slugs and create new days', async ({
  page,
  baseURL,
}) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
  await page.waitForURL('**/owner');
  const created = await page.request.post('/_emdash/api/content/beers', {
    headers,
    data: {
      slug: 'sample-legacy-beer-day',
      data: { title: 'sample legacy beer day', day: '2099-10-18', count: 1 },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = savedBeer.parse(await created.json()).data.item.id;
  const saved = await page.request.post('/api/trip/beers', {
    headers,
    data: { day: '2099-10-18', count: 2 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  expect(savedBeer.parse(await saved.json()).data.item).toMatchObject({
    id,
    status: 'published',
    data: { day: '2099-10-18', count: 2 },
  });
  const fresh = await page.request.post('/api/trip/beers', {
    headers,
    data: { day: '2099-10-19', count: 2 },
  });
  expect(fresh.ok(), await fresh.text()).toBe(true);
  const newId = savedBeer.parse(await fresh.json()).data.item.id;
  expect(newId).not.toBe(id);
  for (const entryId of [id, newId]) {
    const deleted = await page.request.delete(
      `/_emdash/api/content/beers/${entryId}`,
      { headers },
    );
    expect(deleted.ok()).toBe(true);
  }
});

test('owner can save a beer day whose earlier entry is in trash', async ({
  page,
  baseURL,
}, testInfo) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  const setup = await page.request.post('/_emdash/api/setup/dev-bypass', {
    headers,
    data: {},
  });
  expect(setup.ok()).toBe(true);
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
  await page.waitForURL('**/owner');
  for (const path of ['/api/trip/beers', '/_emdash/api/content/beers']) {
    expect((await page.request.get(path)).status()).toBeLessThan(500);
  }
  const first = await page.request.post('/api/trip/beers', {
    headers,
    data: { day: '2099-10-20', count: 1 },
  });
  expect(first.ok(), await first.text()).toBe(true);
  const original = savedBeer.parse(await first.json()).data.item;
  const deleted = await page.request.delete(
    `/_emdash/api/content/beers/${original.id}`,
    { headers },
  );
  expect(deleted.ok()).toBe(true);
  await page.getByLabel('Beer day', { exact: true }).fill('2099-10-20');
  await page.getByLabel('Daily beers', { exact: true }).fill('3');
  const saving = page.waitForResponse('**/api/trip/beers');
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  const saved = await saving;
  expect(saved.ok(), await saved.text()).toBe(true);
  await expect(page.getByRole('status')).toHaveText('saved');
  await page.screenshot({ path: testInfo.outputPath('beer-save-after.png') });
  const replacement = savedBeer.parse(await saved.json()).data.item;
  expect(replacement).toMatchObject({
    status: 'published',
    data: { day: '2099-10-20', count: 3 },
  });
  expect(replacement.id).not.toBe(original.id);
  try {
    const repeated = await page.request.post('/api/trip/beers', {
      headers,
      data: { day: '2099-10-20', count: 2 },
    });
    expect(repeated.ok(), await repeated.text()).toBe(true);
    expect(savedBeer.parse(await repeated.json()).data.item).toMatchObject({
      id: replacement.id,
      status: 'published',
      data: { day: '2099-10-20', count: 2 },
    });
    const trash = await page.request.get('/_emdash/api/content/beers/trash');
    expect(trash.ok()).toBe(true);
    const trashed = z
      .object({
        data: z.object({
          items: z.array(
            z.object({
              id: z.string(),
              deletedAt: z.string(),
              data: z.object({ day: z.string(), count: z.number() }),
            }),
          ),
        }),
      })
      .parse(await trash.json());
    expect(
      trashed.data.items.find(({ id }) => id === original.id),
    ).toMatchObject({
      id: original.id,
      data: { day: '2099-10-20', count: 1 },
    });
    const active = await page.request.get('/_emdash/api/content/beers');
    const listed = z
      .object({
        data: z.object({
          items: z.array(
            z.object({
              id: z.string(),
              data: z.object({ day: z.string(), count: z.number() }),
            }),
          ),
        }),
      })
      .parse(await active.json());
    expect(
      listed.data.items.filter(({ data }) => data.day === '2099-10-20'),
    ).toEqual([{ id: replacement.id, data: { day: '2099-10-20', count: 2 } }]);
  } finally {
    expect(
      (
        await page.request.delete(
          `/_emdash/api/content/beers/${replacement.id}`,
          { headers },
        )
      ).ok(),
    ).toBe(true);
  }
});

for (const trashed of [false, true]) {
  test(`overlapping beer saves keep one active day with trash=${String(trashed)}`, async ({
    page,
    baseURL,
  }) => {
    const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
    const setup = await page.request.post('/_emdash/api/setup/dev-bypass', {
      headers,
      data: {},
    });
    expect(setup.ok()).toBe(true);
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
    await page.waitForURL('**/owner');
    const day = trashed ? '2099-10-22' : '2099-10-21';
    if (trashed) {
      const first = await page.request.post('/api/trip/beers', {
        headers,
        data: { day, count: 1 },
      });
      expect(first.ok(), await first.text()).toBe(true);
      const id = savedBeer.parse(await first.json()).data.item.id;
      expect(
        (
          await page.request.delete(`/_emdash/api/content/beers/${id}`, {
            headers,
          })
        ).ok(),
      ).toBe(true);
    }
    const saves = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        await new Promise((resolve) => setTimeout(resolve, index * 3));
        return page.request.post('/api/trip/beers', {
          headers,
          data: { day, count: 3 },
        });
      }),
    );
    expect(saves.some((response) => response.ok())).toBe(true);
    for (const response of saves) {
      expect([200, 409], await response.text()).toContain(response.status());
    }
    const entries = async () => {
      const response = await page.request.get('/_emdash/api/content/beers');
      expect(response.ok()).toBe(true);
      const listed = z
        .object({
          data: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                data: z.object({ day: z.string(), count: z.number() }),
              }),
            ),
          }),
        })
        .parse(await response.json());
      return listed.data.items.filter(({ data }) => data.day === day);
    };
    const active = await entries();
    expect(active).toHaveLength(1);
    const repeated = await page.request.post('/api/trip/beers', {
      headers,
      data: { day, count: 2 },
    });
    expect(repeated.ok(), await repeated.text()).toBe(true);
    expect(await entries()).toEqual([
      { id: active[0]?.id, data: { day, count: 2 } },
    ]);
    for (const { id } of active) {
      expect(
        (
          await page.request.delete(`/_emdash/api/content/beers/${id}`, {
            headers,
          })
        ).ok(),
      ).toBe(true);
    }
  });
}
