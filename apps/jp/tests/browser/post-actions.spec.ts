import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';

const nativePost = z.object({
  data: z.object({
    item: z.object({ id: z.string(), status: z.string() }),
    _rev: z.string(),
  }),
});
async function createPost(page: Page, baseURL: string, title: string) {
  const created = await page.request.post('/_emdash/api/content/posts', {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL },
    data: {
      slug: `synthetic-actions-${crypto.randomUUID()}`,
      data: { title, day: '2099-10-15', place: 'local fixture', gallery: [] },
    },
  });
  expect(created.status()).toBe(201);
  return nativePost.parse(await created.json()).data;
}

async function hasUnsavedChanges(page: Page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test.beforeEach(async ({ page, baseURL }) => {
  const setup = await page.request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
    data: {},
  });
  expect(setup.ok()).toBe(true);
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
  await page.waitForURL('**/owner');
});

test('owner unpublishes to an editable draft and confirms CMS trash deletion', async ({
  page,
  baseURL,
  browser,
}) => {
  const headers = { 'X-EmDash-Request': '1', Origin: baseURL ?? '' };
  const fixture = await createPost(
    page,
    baseURL ?? '',
    'synthetic action post',
  );
  const other = await createPost(
    page,
    baseURL ?? '',
    'synthetic untouched draft',
  );
  const id = fixture.item.id;
  const published = await page.request.post(
    `/_emdash/api/content/posts/${id}/publish`,
    { headers, data: { _rev: fixture._rev } },
  );
  expect(published.ok()).toBe(true);
  const publicContext = await browser.newContext({ baseURL });
  try {
    const publicPage = await publicContext.newPage();
    expect((await publicPage.goto(`/posts/${id}`))?.status()).toBe(200);
    await page.goto(`/owner/posts/${id}`);
    const unpublish = page.getByRole('button', {
      name: 'UNPUBLISH',
      exact: true,
    });
    await expect(unpublish).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'SAVE DRAFT', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'PUBLISH', exact: true }),
    ).toBeEnabled();
    expect(await hasUnsavedChanges(page)).toBe(false);
    let leavePrompts = 0;
    page.on('dialog', (dialog) => {
      leavePrompts++;
      void dialog.dismiss();
    });
    await page
      .getByRole('button', { name: 'DELETE POST', exact: true })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'CANCEL', exact: true })
      .click();
    expect(await hasUnsavedChanges(page)).toBe(false);
    await page.getByRole('link', { name: 'VIEW POST', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/posts/${id}$`));
    expect(leavePrompts).toBe(0);
    await page.goto(`/owner/posts/${id}`);
    await expect(unpublish).toBeVisible();

    await page
      .getByLabel('title', { exact: true })
      .fill('unsaved synthetic title');
    expect(await hasUnsavedChanges(page)).toBe(true);
    await unpublish.click();
    await expect(page.getByRole('status')).toContainText('unpublished');
    expect(await hasUnsavedChanges(page)).toBe(true);
    await expect(page.getByLabel('title', { exact: true })).toHaveValue(
      'unsaved synthetic title',
    );
    expect((await publicPage.goto(`/posts/${id}`))?.status()).toBe(404);
    await publicPage.goto('/');
    await expect(
      publicPage.getByText('synthetic action post', { exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('draft saved');
    expect(await hasUnsavedChanges(page)).toBe(false);
    await page.reload();
    await expect(page.getByLabel('title', { exact: true })).toHaveValue(
      'unsaved synthetic title',
    );
    await expect(unpublish).toHaveCount(0);
    const deletePost = page.getByRole('button', {
      name: 'DELETE POST',
      exact: true,
    });
    await deletePost.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'delete post?' });
    await expect(dialog).toBeVisible();
    const cancel = dialog.getByRole('button', { name: 'CANCEL', exact: true });
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      dialog.getByRole('button', { name: 'DELETE', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(deletePost).toBeFocused();
    expect((await page.request.get(`/api/trip/posts?id=${id}`)).status()).toBe(
      200,
    );
    await deletePost.click();
    await cancel.click();
    await expect(deletePost).toBeFocused();
    expect((await page.request.get(`/api/trip/posts?id=${id}`)).status()).toBe(
      200,
    );
    await page
      .getByLabel('title', { exact: true })
      .fill('synthetic discarded edit');
    await deletePost.click();
    await expect(dialog).toContainText('unsaved edits will be discarded.');
    await dialog.getByRole('button', { name: 'DELETE', exact: true }).click();
    await expect(page).toHaveURL(/\/owner$/);
    await expect(
      page.getByRole('row').filter({ hasText: 'unsaved synthetic title' }),
    ).toHaveCount(0);
    expect((await page.request.get(`/api/trip/posts?id=${id}`)).status()).toBe(
      404,
    );
    expect(
      (await page.request.get(`/api/trip/posts?id=${other.item.id}`)).status(),
    ).toBe(200);
    const trash = await page.request.get('/_emdash/api/content/posts/trash');
    expect(JSON.stringify(await trash.json())).toContain(id);
  } finally {
    await publicContext.close();
  }
});

test('pending and failed lifecycle requests keep the editor and confirmation', async ({
  page,
  baseURL,
}) => {
  const fixture = await createPost(page, baseURL ?? '', 'synthetic error post');
  const id = fixture.item.id;
  await page.request.post(`/_emdash/api/content/posts/${id}/publish`, {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
    data: { _rev: fixture._rev },
  });
  await page.goto(`/owner/posts/${id}`);
  for (const action of ['unpublish', 'delete']) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const path = `**/_emdash/api/content/posts/${id}${action === 'unpublish' ? '/unpublish' : ''}`;
    await page.route(path, async (route) => {
      requests++;
      await gate;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'synthetic mutation rejected' },
        }),
      });
    });
    if (action === 'delete') {
      await page
        .getByRole('button', { name: 'DELETE POST', exact: true })
        .click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'DELETE', exact: true })
        .click();
    } else {
      await page
        .getByRole('button', { name: 'UNPUBLISH', exact: true })
        .click();
    }
    await expect(
      page.getByRole('button', {
        name: 'SAVE DRAFT',
        exact: true,
        includeHidden: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', {
        name: 'PUBLISH',
        exact: true,
        includeHidden: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', {
        name: 'DELETE POST',
        exact: true,
        includeHidden: true,
      }),
    ).toBeDisabled();
    if (action === 'delete') {
      await expect(
        page.getByRole('button', {
          name: 'CANCEL',
          exact: true,
          includeHidden: true,
        }),
      ).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('alertdialog')).toBeVisible();
    }
    release();
    await expect(
      page.getByRole(action === 'delete' ? 'alert' : 'status'),
    ).toHaveText('synthetic mutation rejected');
    expect(requests).toBe(1);
    await expect(page.getByLabel('title', { exact: true })).toHaveValue(
      'synthetic error post',
    );
    expect(new URL(page.url()).pathname).toBe(`/owner/posts/${id}`);
    if (action === 'delete')
      await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
    await page.unroute(path);
  }
  expect((await page.request.get(`/api/trip/posts?id=${id}`)).status()).toBe(
    200,
  );
  expect(await hasUnsavedChanges(page)).toBe(false);
  await page.getByRole('button', { name: 'UNPUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('unpublished');
  expect(await hasUnsavedChanges(page)).toBe(false);
  let leavePrompts = 0;
  page.on('dialog', (dialog) => {
    leavePrompts++;
    void dialog.dismiss();
  });
  await page.goto('/owner');
  await expect(page).toHaveURL(/\/owner$/);
  expect(leavePrompts).toBe(0);
});
