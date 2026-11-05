import { test, expect, type Locator } from '@playwright/test';

async function paste(editor: Locator, text: string, html = '') {
  await editor.evaluate(
    (element, value) => {
      const data = new DataTransfer();
      data.setData('text/plain', value.text);
      if (value.html) data.setData('text/html', value.html);
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    },
    { text, html },
  );
}

async function clear(editor: Locator) {
  await editor.press('ControlOrMeta+a');
  await editor.press('Backspace');
  await expect(editor).toHaveText('');
}

test.beforeAll(async ({ request, baseURL }) => {
  const setup = await request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL || '' },
    data: {},
  });
  expect(setup.ok()).toBe(true);
});

test.beforeEach(async ({ page }) => {
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await expect(
    page.getByRole('textbox', { name: 'Post content' }),
  ).toBeVisible();
});

test('profile paste retains formatting, supports undo, saves and reopens as a real link', async ({
  page,
  context,
}) => {
  const editor = page.getByRole('textbox', { name: 'Post content' });
  await page
    .getByLabel('title', { exact: true })
    .fill('Sample Instagram profile');
  await editor.fill('Sample profile: ');
  await editor.press('End');
  await editor.press('ControlOrMeta+b');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => {
    await navigator.clipboard.writeText(
      'https://instagram.com/sample.travels/?igsh=synthetic',
    );
  });
  await editor.press('ControlOrMeta+v');
  const link = editor.getByRole('link', {
    name: '@sample.travels',
    exact: true,
  });
  await expect(link).toHaveAttribute(
    'href',
    'https://www.instagram.com/sample.travels/',
  );
  await expect(editor.locator('strong')).toContainText('@sample.travels');
  await page.keyboard.insertText(' after');
  await expect(link).toHaveText('@sample.travels');
  await expect(
    editor.locator('strong').filter({ hasText: ' after' }),
  ).toContainText(' after');
  await editor.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Sample profile: ');
  await editor.press('ControlOrMeta+Shift+z');
  await expect(link).toBeVisible();
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  await page.reload();
  await expect(link).toHaveAttribute(
    'href',
    'https://www.instagram.com/sample.travels/',
  );
  await expect(editor).toHaveText('Sample profile: @sample.travels after');
  await expect(
    editor.locator('strong').filter({ hasText: '@sample.travels' }),
  ).toContainText('@sample.travels');
  await expect(
    editor.locator('strong').filter({ hasText: ' after' }),
  ).toContainText(' after');
  // The same extension runs when editing an existing post, including selection replacement.
  await editor.fill('replace me');
  await editor.press('ControlOrMeta+a');
  await paste(editor, 'www.instagram.com/another_sample/');
  await expect(editor).toHaveText('@another_sample');
  await expect(editor.getByRole('link')).toHaveAttribute(
    'href',
    'https://www.instagram.com/another_sample/',
  );
});

test('non-profile paste, rich content, ordinary links and code keep normal behavior', async ({
  page,
}) => {
  const editor = page.getByRole('textbox', { name: 'Post content' });
  for (const text of [
    'https://www.instagram.com/p/ABC/',
    'https://instagram.com/reel/ABC/',
    'https://instagram.com/stories/sample/123/',
    'https://instagram.com/explore/',
    'https://instagram.com.evil.test/sample/',
    'https://evil.test@instagram.com/sample/',
    'https://example.com/sample/',
    'ordinary text',
    'See https://instagram.com/sample/ later',
  ]) {
    await clear(editor);
    await paste(editor, text);
    await expect(editor).toHaveText(text);
    await expect(editor.getByRole('link', { name: /^@/ })).toHaveCount(0);
  }
  await clear(editor);
  await paste(
    editor,
    'Rich text',
    '<p><strong>Rich</strong> <em>text</em></p>',
  );
  await expect(editor.locator('strong')).toHaveText('Rich');
  await expect(editor.locator('em')).toHaveText('text');
  await clear(editor);
  await paste(
    editor,
    'https://instagram.com/sample/',
    '<p><strong>https://instagram.com/sample/</strong></p>',
  );
  await expect(editor.locator('strong')).toHaveText(
    'https://instagram.com/sample/',
  );
  await clear(editor);
  await paste(
    editor,
    'https://instagram.com/sample/',
    '<p>https://instagram.com/sample/</p><p>keep this paragraph</p>',
  );
  await expect(editor.locator('p')).toHaveCount(2);
  await expect(editor).toContainText('keep this paragraph');
  await clear(editor);
  await editor.press('ControlOrMeta+e');
  await page.keyboard.insertText('code ');
  await expect(editor.locator('code')).toHaveText('code ');
  await paste(editor, 'https://instagram.com/sample/');
  await expect(editor.locator('code')).toHaveText(
    'code https://instagram.com/sample/',
  );
  await expect(editor.locator('a')).toHaveCount(0);
  await editor.press('ControlOrMeta+e');
  await editor.press('ControlOrMeta+a');
  await editor.press('Backspace');
  await editor.press('ControlOrMeta+Alt+c');
  await paste(editor, 'https://instagram.com/sample/');
  await expect(editor.locator('pre code')).toHaveText(
    'https://instagram.com/sample/',
  );
  await expect(editor.locator('a')).toHaveCount(0);
});
