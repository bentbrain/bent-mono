import { test, expect } from '@playwright/test';
import { z } from 'zod';

test('owner account link opens native passkey settings', async ({
  page,
  baseURL,
}) => {
  const setup = await test.step('measure: native admin setup', () =>
    page.request.post('/_emdash/api/setup/dev-bypass', {
      headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
      data: {},
    }));
  expect(setup.ok()).toBe(true);
  await test.step('measure: native admin owner navigation', async () => {
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
    await page.waitForURL((url) => url.pathname === '/owner');
    await page.getByRole('button', { name: 'admin', exact: true }).click();
    const account = page.getByRole('menuitem', {
      name: 'account',
      exact: true,
    });
    await expect(account).toBeVisible();
    await expect(
      page.locator('main').getByRole('link', { name: /account/ }),
    ).toHaveCount(0);
    await test.step('measure: native admin cold route to usable passkeys', async () => {
      const currentUser = await page.request.get('/_emdash/api/auth/me');
      expect(currentUser.ok()).toBe(true);
      const {
        data: { isFirstLogin },
      } = z
        .object({ data: z.object({ isFirstLogin: z.boolean() }) })
        .parse(await currentUser.json());
      await account.click();
      await expect(page).toHaveURL(/\/_emdash\/admin\/settings\/security$/);
      const security = page.getByRole('heading', {
        name: 'Security Settings',
        exact: true,
      });
      const welcome = page.getByRole('button', {
        name: 'Get Started',
        exact: true,
      });
      // A cold Vite cache compiles the native admin and can reload it once.
      // Security can render before the user query opens its welcome modal.
      // Wait for the expected onboarding state before checking passkey controls.
      await expect(isFirstLogin ? welcome : security).toBeVisible({
        timeout: 30_000,
      });
      if (isFirstLogin) await welcome.click();
      await expect(security).toBeVisible();
      await expect(
        page.getByRole('heading', { name: /passkeys/i }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Add Passkey' }),
      ).toBeVisible();
    });
  });
});

test('public navigation omits the owner account link', async ({ page }) => {
  await page.goto('/');
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'account', exact: true }),
  ).toHaveCount(0);
});
