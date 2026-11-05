import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test.beforeAll(async ({ request, baseURL }) => {
  const setup = await request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1', Origin: baseURL || '' },
    data: {},
  });
  expect(setup.ok()).toBe(true);
  await promisify(execFile)('bun', ['demo'], {
    env: { ...process.env, TEST_BASE_URL: baseURL },
  });
});

test.beforeEach(async ({ page }) => {
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
});

for (const width of [320, 390, 768, 1280]) {
  for (const colorScheme of ['light', 'dark']) {
    test(`journal title and date stay horizontal at ${String(width)}px in ${colorScheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({
        colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
      });
      await page.goto('/');
      const heading = page.locator('article .post-heading').first();
      const link = heading.getByRole('link');
      const date = heading.locator('time');
      const href = await link.getAttribute('href');
      for (const title of [
        'sample post',
        'sample post with a long title that wraps across several lines',
        'sample'.repeat(30),
      ]) {
        await link.evaluate((element, text) => {
          element.textContent = text;
        }, title);
        await expect(heading).toHaveCSS('flex-direction', 'row');
        const titleBox = await heading.locator('h1').boundingBox();
        const dateBox = await date.boundingBox();
        const headingBox = await heading.boundingBox();
        if (!titleBox || !dateBox || !headingBox)
          throw new Error('Post heading must be visible');
        expect(titleBox.x + titleBox.width).toBeLessThan(dateBox.x);
        expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(
          headingBox.x + headingBox.width,
        );
        expect(
          Math.abs(
            titleBox.y + titleBox.height / 2 - (dateBox.y + dateBox.height / 2),
          ),
        ).toBeLessThan(1);
        expect(
          await heading
            .locator('h1')
            .evaluate((element) => element.scrollWidth),
        ).toBeLessThanOrEqual(Math.ceil(titleBox.width));
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      }
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${href || '/posts/'}$`));
      await expect(page.locator('.single-post')).toBeVisible();
    });
  }
}
