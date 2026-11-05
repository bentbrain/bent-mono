import { test, expect } from '@playwright/test';

test.beforeAll(async ({ request, baseURL }) => {
  const setup = await request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL || '' },
    data: {},
  });
  expect(setup.ok()).toBe(true);
});

test('code saves, reopens and stays distinct in the editor, feed and post in both themes', async ({
  page,
}) => {
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  await page.waitForURL('**/owner/posts/new');
  await page
    .getByLabel('title', { exact: true })
    .fill('Sample code formatting');
  const editor = page.getByRole('textbox', { name: 'Post content' });
  await editor.fill('Run ');
  await editor.press('End');
  await editor.press('ControlOrMeta+e');
  await page.keyboard.type('bun run build');
  await editor.press('ControlOrMeta+e');
  await page.keyboard.type(' before publishing.');
  await editor.press('Enter');
  await editor.press('ControlOrMeta+Alt+c');
  const code = `const html = '<img src=x onerror="alert(1)">';\n\n  console.log("${'long-line-'.repeat(30)}");\n`;
  await page.keyboard.insertText(code);
  await expect(editor.locator('p code')).toHaveText('bun run build');
  expect(await editor.locator('pre code').textContent()).toBe(code);
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  const editorURL = page.url();
  await page.reload();
  await expect(editor.locator('p code')).toHaveText('bun run build');
  expect(await editor.locator('pre code').textContent()).toBe(code);
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('published');
  await page.goto('/');
  const postURL = await page
    .getByRole('link', { name: 'Sample code formatting', exact: true })
    .getAttribute('href');
  if (!postURL) throw new Error('Published sample post link required');

  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({
        colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
      });
      for (const route of [editorURL, '/', postURL]) {
        await page.goto(route);
        const content =
          route === editorURL
            ? editor
            : page.locator('.post-body').filter({ hasText: 'bun run build' });
        const inline = content.locator('p code');
        const pre = content.locator('pre');
        await expect(inline).toHaveText('bun run build');
        expect(await pre.locator('code').textContent()).toBe(code);
        await expect(content.locator('img')).toHaveCount(0);
        const background =
          colorScheme === 'dark' ? 'rgb(11, 19, 41)' : 'rgb(243, 246, 255)';
        await expect(inline).toHaveCSS('background-color', background);
        await expect(inline).toHaveCSS('border-top-width', '1px');
        await expect(pre).toHaveCSS('background-color', background);
        await expect(pre).toHaveCSS('border-top-width', '1px');
        await expect(pre).toHaveCSS('border-radius', '0px');
        await expect(pre).toHaveCSS('white-space', 'pre');
        await expect(pre.locator('code')).toHaveCSS('border-top-width', '0px');
        expect(
          await pre.evaluate(
            (element) => element.scrollWidth > element.clientWidth,
          ),
        ).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        if (route !== editorURL)
          await expect(pre).toHaveAttribute('tabindex', '0');
      }
    }
  }
});
