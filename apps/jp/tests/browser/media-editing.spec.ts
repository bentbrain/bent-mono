import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';

const entry = z.object({
  data: z.object({
    _rev: z.string(),
    item: z.object({
      id: z.string(),
      status: z.string(),
      data: z.record(z.string(), z.unknown()),
      liveData: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
});
async function fixtures(page: Page, baseURL: string | undefined) {
  await page.goto('/_emdash/api/setup/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  const headers = { Origin: baseURL || '', 'X-EmDash-Request': '1' };
  const records: z.infer<typeof entry>['data'][] = [];
  for (const title of [
    'sample draft',
    'sample published',
    'sample untouched',
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
            longitude: 139.6917,
            place: 'sample Kyoto',
            categories: ['food', 'people'],
            source_url: '/demo/japan.jpg',
            demo: true,
          },
        },
      },
    );
    expect(response.status()).toBe(201);
    let record = entry.parse(await response.json()).data;
    if (title === 'sample published') {
      const published = await page.request.post(
        `/_emdash/api/content/media_items/${record.item.id}/publish`,
        { headers, data: { _rev: record._rev } },
      );
      expect(published.status()).toBe(200);
      record = entry.parse(await published.json()).data;
    }
    records.push(record);
  }
  let refreshes = 0;
  await page.route('**/api/trip/media', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    refreshes++;
    const response = await route.fetch();
    const body = z
      .object({ items: z.array(z.looseObject({ id: z.string() })) })
      .parse(await response.json());
    await route.fulfill({
      response,
      json: {
        items: body.items.filter((item) =>
          records.some((record) => record.item.id === item.id),
        ),
      },
    });
  });
  await page.reload();
  await expect(page.locator('#media-list button')).toHaveCount(3);
  return {
    headers,
    records,
    resetRefreshes: () => {
      refreshes = 0;
    },
    refreshCount: () => refreshes,
  };
}

for (const width of [1280, 390])
  test(`bulk edit drafts and published photos at ${String(width)}px without changing original metadata`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { records, resetRefreshes, refreshCount } = await fixtures(
      page,
      baseURL,
    );
    await page.getByRole('button', { name: 'SELECT', exact: true }).click();
    for (const name of ['sample draft, draft', 'sample published, published'])
      await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'EDIT (2)', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'edit 2 photos' });
    await expect(
      dialog.getByRole('button', { name: 'APPLY (2)' }),
    ).toBeDisabled();
    await expect(
      dialog.locator(
        'input[type=date], input[type=datetime-local], input[type=number]',
      ),
    ).toHaveCount(0);
    await expect(dialog).toHaveAttribute('data-feedback-private', 'true');
    await dialog
      .getByRole('checkbox', { name: 'change place', exact: true })
      .check();
    await dialog
      .getByRole('combobox', { name: 'new place' })
      .fill('sample Tokyo');
    resetRefreshes();
    await dialog.getByRole('button', { name: 'APPLY (2)' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#edit-status')).toHaveText('2 saved');
    expect(refreshCount()).toBe(0);
    await expect(page.getByRole('button', { name: 'EDIT (2)' })).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'PUBLISH (1)' }),
    ).toBeEnabled();
    for (const record of records) {
      const stored = entry.parse(
        await (
          await page.request.get(
            `/_emdash/api/content/media_items/${record.item.id}`,
          )
        ).json(),
      ).data.item;
      const untouched = record.item.data.title === 'sample untouched';
      expect(stored.status).toBe(record.item.status);
      expect(stored.data).toEqual({
        ...record.item.data,
        ...(untouched ? {} : { place: 'sample Tokyo' }),
      });
      if (stored.status === 'published')
        expect(stored.liveData).toBeUndefined();
    }
    // Reuse the same selection for title and category edits.
    await page.getByRole('button', { name: 'EDIT (2)' }).click();
    await dialog
      .getByRole('checkbox', { name: 'change title', exact: true })
      .check();
    await dialog
      .getByRole('textbox', { name: 'new title' })
      .fill('sample shared title');
    await dialog
      .getByRole('checkbox', { name: 'change categories', exact: true })
      .check();
    await dialog.getByRole('button', { name: 'REMOVE', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'people', exact: true }).check();
    await dialog.getByRole('button', { name: 'APPLY (2)' }).click();
    await expect(dialog).toBeHidden();
    for (const record of records.filter(
      (record) => record.item.data.title !== 'sample untouched',
    )) {
      const stored = entry.parse(
        await (
          await page.request.get(
            `/_emdash/api/content/media_items/${record.item.id}`,
          )
        ).json(),
      ).data.item;
      expect(stored.data).toEqual({
        ...record.item.data,
        title: 'sample shared title',
        place: 'sample Tokyo',
        categories: ['food'],
      });
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test('partial failures retain only failed selections and protect unpublished edits', async ({
  page,
  baseURL,
}) => {
  const { headers, records, resetRefreshes, refreshCount } = await fixtures(
    page,
    baseURL,
  );
  const draft = records.find((record) => record.item.status === 'draft');
  const published = records.find(
    (record) => record.item.status === 'published',
  );
  if (!draft || !published) throw new Error('Missing sample records');
  await page.getByRole('button', { name: 'SELECT', exact: true }).click();
  await page.getByRole('button', { name: 'SELECT ALL', exact: true }).click();
  await page.getByRole('button', { name: 'EDIT (3)' }).click();
  const changed = await page.request.put(
    `/_emdash/api/content/media_items/${draft.item.id}`,
    {
      headers,
      data: { _rev: draft._rev, data: { place: 'sample newer place' } },
    },
  );
  expect(changed.status()).toBe(200);
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('checkbox', { name: 'change categories', exact: true })
    .check();
  await dialog.getByRole('checkbox', { name: 'beer', exact: true }).check();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/api/trip/media/edit', async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  resetRefreshes();
  const request = page.waitForRequest('**/api/trip/media/edit');
  await dialog.getByRole('button', { name: 'APPLY (3)' }).click();
  await request;
  await expect(dialog.getByRole('button', { name: 'SAVING' })).toBeDisabled();
  await expect(
    dialog.getByRole('checkbox', { name: 'change title' }),
  ).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect.poll(() => requests).toBe(3);
  release();
  await expect(dialog).toContainText('2 saved; 1 failed');
  await expect(dialog).toContainText(
    'Photo changed. Review it before retrying.',
  );
  expect(refreshCount()).toBe(1);
  await dialog.getByRole('button', { name: 'APPLY (1)' }).click();
  await expect(dialog).toBeHidden();
  expect(requests).toBe(4);
  const latest = entry.parse(
    await (
      await page.request.get(
        `/_emdash/api/content/media_items/${draft.item.id}`,
      )
    ).json(),
  ).data;
  expect(latest.item.data.place).toBe('sample newer place');
  expect(latest.item.data.categories).toEqual(['food', 'people', 'beer']);
  const pub = entry.parse(
    await (
      await page.request.get(
        `/_emdash/api/content/media_items/${published.item.id}`,
      )
    ).json(),
  ).data;
  const pending = await page.request.put(
    `/_emdash/api/content/media_items/${pub.item.id}`,
    {
      headers,
      data: { _rev: pub._rev, data: { place: 'sample unpublished place' } },
    },
  );
  const pendingEntry = entry.parse(await pending.json()).data;
  const rejected = await page.request.patch('/api/trip/media/edit', {
    headers,
    data: {
      id: pub.item.id,
      revision: pendingEntry._rev,
      changes: { title: 'sample bulk title' },
    },
  });
  expect(rejected.status()).toBe(409);
  const after = entry.parse(
    await (
      await page.request.get(`/_emdash/api/content/media_items/${pub.item.id}`)
    ).json(),
  ).data;
  expect(after).toEqual(pendingEntry);
});

test('edit API requires owner and CSRF protection and rejects capture metadata', async ({
  page,
  baseURL,
  playwright,
}) => {
  const { headers, records } = await fixtures(page, baseURL);
  const record = records[0];
  if (!record) throw new Error('Missing sample record');
  const data = {
    id: record.item.id,
    revision: record._rev,
    changes: { place: 'sample Tokyo' },
  };
  const anonymous = await playwright.request.newContext({ baseURL });
  expect(
    (await anonymous.patch('/api/trip/media/edit', { headers, data })).status(),
  ).toBe(401);
  await anonymous.dispose();
  expect(
    (await page.request.patch('/api/trip/media/edit', { data })).status(),
  ).toBe(403);
  expect(
    (
      await page.request.patch('/api/trip/media/edit', {
        headers: { ...headers, Origin: 'https://foreign.example' },
        data,
      })
    ).status(),
  ).toBe(403);
  for (const changes of [
    {},
    { latitude: 0 },
    { longitude: 0 },
    { captured_at: '2099-10-16T00:00:00Z' },
    { title: 'sample title', asset: null },
  ]) {
    expect(
      (
        await page.request.patch('/api/trip/media/edit', {
          headers,
          data: { ...data, changes },
        })
      ).status(),
    ).toBe(400);
  }
  const stored = entry.parse(
    await (
      await page.request.get(
        `/_emdash/api/content/media_items/${record.item.id}`,
      )
    ).json(),
  ).data;
  expect(stored._rev).toBe(record._rev);
  expect(stored.item.status).toBe(record.item.status);
  expect(stored.item.data).toEqual(record.item.data);
  const incomplete = await page.request.post(
    '/_emdash/api/content/media_items',
    {
      headers,
      data: {
        slug: crypto.randomUUID(),
        data: {
          title: 'sample missing metadata',
          kind: 'photo',
          categories: ['food'],
        },
      },
    },
  );
  let current = entry.parse(await incomplete.json()).data;
  const original = current.item.data;
  for (const changes of [
    { place: '' },
    { categories: { mode: 'add', names: ['people'] } },
    { categories: { mode: 'replace', names: [] } },
  ]) {
    const response = await page.request.patch('/api/trip/media/edit', {
      headers,
      data: { id: current.item.id, revision: current._rev, changes },
    });
    expect(response.status()).toBe(200);
    current = entry.parse(
      await (
        await page.request.get(
          `/_emdash/api/content/media_items/${current.item.id}`,
        )
      ).json(),
    ).data;
  }
  expect(current.item.status).toBe('draft');
  expect(current.item.data).toEqual({ ...original, place: '', categories: [] });
});

test('five place edits run with bounded concurrency and finish without a library refresh', async ({
  page,
  baseURL,
}) => {
  const { headers, records, resetRefreshes, refreshCount } = await fixtures(
    page,
    baseURL,
  );
  for (let i = 4; i <= 5; i++) {
    const created = await page.request.post(
      '/_emdash/api/content/media_items',
      {
        headers,
        data: {
          slug: crypto.randomUUID(),
          data: {
            title: `sample photo ${String(i)}`,
            kind: 'photo',
            captured_at: '2099-10-15T01:23:45.678Z',
            latitude: 0,
            longitude: 139,
            place: 'sample Kyoto',
            categories: [],
            source_url: '/demo/japan.jpg',
            demo: true,
          },
        },
      },
    );
    expect(created.status()).toBe(201);
    records.push(entry.parse(await created.json()).data);
  }
  await page.reload();
  await expect(page.locator('#media-list button')).toHaveCount(5);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let active = 0;
  let peak = 0;
  await page.route('**/api/trip/media/edit', async (route) => {
    started++;
    active++;
    peak = Math.max(peak, active);
    await gate;
    const response = await route.fetch();
    active--;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'SELECT', exact: true }).click();
  await page.getByRole('button', { name: 'SELECT ALL', exact: true }).click();
  await page.getByRole('button', { name: 'EDIT (5)' }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('checkbox', { name: 'change place', exact: true })
    .check();
  await dialog
    .getByRole('combobox', { name: 'new place' })
    .fill('sample Tokyo');
  resetRefreshes();
  await dialog.getByRole('button', { name: 'APPLY (5)' }).click();
  await expect.poll(() => started).toBe(4);
  await dialog.getByRole('button', { name: 'CLOSE', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#edit-status')).toContainText('saving');
  release();
  await expect(page.locator('#edit-status')).toHaveText('5 saved');
  expect(started).toBe(5);
  expect(peak).toBe(4);
  expect(refreshCount()).toBe(0);
  for (const record of records) {
    const stored = entry.parse(
      await (
        await page.request.get(
          `/_emdash/api/content/media_items/${record.item.id}`,
        )
      ).json(),
    ).data.item;
    expect(stored.data.place).toBe('sample Tokyo');
    expect(stored.data.latitude).toBe(record.item.data.latitude);
    expect(stored.data.captured_at).toBe(record.item.data.captured_at);
    expect(stored.status).toBe(record.item.status);
  }
});

test('individual saves update cached revisions and never wait for a library reload', async ({
  page,
  baseURL,
}) => {
  const { records, resetRefreshes, refreshCount } = await fixtures(
    page,
    baseURL,
  );
  const draft = records.find(
    (record) => record.item.data.title === 'sample draft',
  );
  if (!draft) throw new Error('Missing sample draft');
  await page
    .getByRole('button', { name: 'sample draft, draft', exact: true })
    .click();
  resetRefreshes();
  for (const place of ['sample Tokyo', 'sample Osaka']) {
    await page.getByLabel('place', { exact: true }).fill(place);
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/trip/media') &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'SAVE', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(
      page.getByRole('button', { name: 'SAVE', exact: true }),
    ).toBeEnabled();
    await expect(page.locator('#save-status')).toHaveText('saved');
  }
  expect(refreshCount()).toBe(0);
  const stored = entry.parse(
    await (
      await page.request.get(
        `/_emdash/api/content/media_items/${draft.item.id}`,
      )
    ).json(),
  ).data.item;
  expect(stored.data.place).toBe('sample Osaka');
  expect(stored.data.latitude).toBe(draft.item.data.latitude);
});
