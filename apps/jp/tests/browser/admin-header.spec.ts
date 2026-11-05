import { test, expect } from '@playwright/test';

for (const colorScheme of ['light', 'dark']) {
  for (const width of [320, 390, 1280]) {
    test(`owner navigation at ${String(width)}px in ${colorScheme}`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({
        colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
      });
      const setup = await page.request.post('/_emdash/api/setup/dev-bypass', {
        headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
        data: {},
      });
      expect(setup.ok()).toBe(true);
      await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
      await page.waitForURL((url) => url.pathname === '/owner/media');
      for (const path of ['/owner/media', '/categories', '/', '/gallery']) {
        const response = await page.goto(path);
        expect(response?.headers()['cache-control']).toBe('private, no-store');
        expect(response?.headers()['cdn-cache-control']).toBe('no-store');
        expect(response?.headers()['cloudflare-cdn-cache-control']).toBe(
          'no-store',
        );
        await expect(
          page.locator('[data-feedback-id="brand"]'),
        ).toHaveAttribute('href', '/');
        await expect(page.locator('[data-feedback-id="brand"]')).toHaveText(
          'jp.bent.build',
        );
        const navigation = page.getByRole('navigation', {
          name: 'Main navigation',
        });
        await expect(
          navigation.getByRole('link', { name: 'blog', exact: true }),
        ).toHaveAttribute('href', '/');
        await expect(
          navigation.getByRole('link', { name: 'pics', exact: true }),
        ).toHaveAttribute('href', '/gallery');
        if (path.startsWith('/owner') || path === '/categories') {
          await expect(page.locator('body')).toHaveAttribute(
            'data-feedback-redact',
            'true',
          );
          await expect(page.locator('main')).toHaveAttribute(
            'data-feedback-private',
            'true',
          );
          await expect(page.locator('main')).toHaveAttribute(
            'data-feedback-redact',
            'true',
          );
        } else {
          await expect(page.locator('main')).not.toHaveAttribute(
            'data-feedback-private',
          );
        }
        const trigger = page.getByRole('button', {
          name: 'admin',
          exact: true,
        });
        await expect(trigger).toBeEnabled();
        await trigger.focus();
        await trigger.press('ArrowDown');
        const menu = page.getByRole('menu', { name: 'Admin navigation' });
        await expect(menu).toBeVisible();
        const posts = menu.getByRole('menuitem', {
          name: 'posts',
          exact: true,
        });
        await expect(posts).toBeFocused();
        for (const { name, href } of [
          { name: 'posts', href: '/owner' },
          { name: 'media', href: '/owner/media' },
          { name: 'categories', href: '/categories' },
          { name: 'export', href: '/owner/export' },
          { name: 'account', href: '/_emdash/admin/settings/security' },
        ]) {
          await expect(
            menu.getByRole('menuitem', { name, exact: true }),
          ).toHaveAttribute('href', href);
        }
        if (path === '/categories')
          await expect(
            menu.getByRole('menuitem', { name: 'categories', exact: true }),
          ).toHaveAttribute('aria-current', 'page');
        if (path === '/owner/media')
          await expect(
            menu.getByRole('menuitem', { name: 'media', exact: true }),
          ).toHaveAttribute('aria-current', 'page');
        await posts.press('ArrowDown');
        await expect(
          menu.getByRole('menuitem', { name: 'media', exact: true }),
        ).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(trigger).toBeFocused();
        await trigger.click();
        await expect(menu).toBeVisible();
        const bounds = await menu.boundingBox();
        expect(bounds).not.toBeNull();
        if (bounds) {
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
        // The modal menu's backdrop receives an actual outside pointer click.
        await page.mouse.click(5, 200);
        await expect(menu).toBeHidden();
        await trigger.click();
        await expect(menu).toBeVisible();
        await page.keyboard.press('Tab');
        await expect(menu).toBeHidden();
        await expect(trigger).not.toBeFocused();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      }
      await page.getByRole('button', { name: 'admin', exact: true }).click();
      await expect(
        page.getByRole('menu', { name: 'Admin navigation' }),
      ).toBeVisible();
      await page.getByRole('menuitem', { name: 'media', exact: true }).click();
      await expect(page).toHaveURL(/\/owner\/media$/);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await page.locator('[data-feedback-id="brand"]').click();
      await expect(page).toHaveURL(`${baseURL ?? ''}/`);
      await expect(
        page.getByRole('button', { name: 'admin', exact: true }),
      ).toBeVisible();
      await page.context().clearCookies();
      await page.reload();
      await expect(
        page.getByRole('button', { name: 'admin', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('link', { name: 'account', exact: true }),
      ).toHaveCount(0);
    });
  }
}

test('anonymous visitors get public navigation and protected endpoints stay protected', async ({
  page,
}) => {
  for (const path of ['/', '/gallery']) {
    await page.goto(path);
    await expect(
      page.getByRole('button', { name: 'admin', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'account', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('[data-feedback-id="brand"]')).toHaveAttribute(
      'href',
      '/',
    );
    await expect(page.locator('main')).not.toHaveAttribute(
      'data-feedback-private',
    );
  }
  const categories = await page.request.get('/categories', { maxRedirects: 0 });
  expect(categories.status()).toBe(302);
  expect(categories.headers()['location']).toContain('/_emdash/admin/login');
  const owner = await page.request.get('/owner/media', { maxRedirects: 0 });
  expect(owner.status()).toBe(302);
  expect(owner.headers()['location']).toContain('/_emdash/admin/login');
  expect((await page.request.get('/api/trip/media')).status()).toBe(401);
  expect((await page.request.get('/api/trip/exports')).status()).toBe(401);
});
