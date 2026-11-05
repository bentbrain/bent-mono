import { test, expect, type Locator } from '@playwright/test';

test('clipboard photos upload inline at the paste position without opening media', async ({
  page,
}) => {
  await page.request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1' },
    data: {},
  });
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  const editor = page.getByRole('textbox', { name: 'Post content' });
  await editor.fill('Sample clipboard story');
  await editor.press('End');
  await page.screenshot({ path: 'artifacts/editor-paste-before.png' });
  await pastePhotos(editor);
  await expect(editor.locator('img')).toHaveCount(1, { timeout: 15000 });
  await expect(editor.locator('img')).toHaveAttribute(
    'src',
    /^\/_emdash\/api\/media\/asset\//,
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/editor-paste-after.png' });
  await page
    .getByLabel('title', { exact: true })
    .fill('Sample clipboard photo');
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  await page.reload();
  await expect(editor.locator('img')).toHaveCount(1);
});

async function pastePhotos(editor: Locator, count = 1) {
  await editor.evaluate(async (element, count) => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 80;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas required');
    context.fillStyle = '#0647ff';
    context.fillRect(0, 0, 160, 80);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error('PNG required'));
      }, 'image/png');
    });
    const clipboardData = new DataTransfer();
    for (let index = 0; index < count; index++) {
      clipboardData.items.add(
        new File([blob], `sample-${String(index)}.png`, { type: 'image/png' }),
      );
    }
    clipboardData.setData(
      'text/html',
      '<img src="https://example.invalid/untrusted.png">',
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, count);
}

test('clipboard upload errors stay visible and a later paste retries successfully', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  const editor = page.getByRole('textbox', { name: 'Post content' });
  await editor.fill('Sample retry story');
  await page.route('**/api/trip/upload', (route) =>
    route.fulfill({ status: 400, json: { error: 'synthetic rejection' } }),
  );
  await pastePhotos(editor);
  await expect(page.getByRole('status')).toContainText('Photo upload failed');
  await expect(editor.locator('img')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'SAVE DRAFT', exact: true }),
  ).toBeEnabled();
  await page.unroute('**/api/trip/upload');
  await pastePhotos(editor);
  await expect(editor.locator('img')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('multiple clipboard images keep their paste position while the owner moves the cursor', async ({
  page,
}) => {
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  const editor = page.getByRole('textbox', { name: 'Post content' });
  await editor.fill('Sample first paragraph');
  await editor.press('End');
  await editor.press('Enter');
  await page.keyboard.type('Sample second paragraph');
  await moveToEnd(editor.locator('p').first());
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/trip/upload', async (route) => {
    expect(route.request().headers()['x-emdash-request']).toBe('1');
    await gate;
    await route.continue();
  });
  const uploading = page.waitForRequest('**/api/trip/upload');
  await pastePhotos(editor, 2);
  await uploading;
  await moveToEnd(editor.locator('p').last());
  await page.keyboard.type(' with newer edits');
  expect(await editor.locator('p').allTextContents()).toEqual([
    'Sample first paragraph',
    'Sample second paragraph with newer edits',
  ]);
  release();
  await expect(editor.locator('img')).toHaveCount(2);
  await expect(editor.locator('img').nth(0)).toHaveAttribute(
    'alt',
    'sample-0.png',
  );
  await expect(editor.locator('img').nth(1)).toHaveAttribute(
    'alt',
    'sample-1.png',
  );
  await expect(
    editor.locator('p').filter({ hasText: 'Sample second paragraph' }),
  ).toHaveText('Sample second paragraph with newer edits');
  expect(
    await editor
      .locator(':scope > *')
      .evaluateAll((nodes) => nodes.map((node) => node.tagName)),
  ).toEqual(['P', 'IMG', 'IMG', 'P']);
});

test('media picker errors do not linger in the post status after closing the picker', async ({
  page,
}) => {
  await page.route('**/api/trip/media', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'Sample media lookup failed' },
    }),
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.getByRole('button', { name: '+ MEDIA', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText(
    'Sample media lookup failed',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
});

async function moveToEnd(paragraph: Locator) {
  await paragraph.evaluate((element) => {
    const editor = element.closest('[contenteditable="true"]');
    if (editor instanceof HTMLElement) editor.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await paragraph.page().keyboard.press('ArrowLeft');
  await paragraph.page().keyboard.press('ArrowRight');
}
