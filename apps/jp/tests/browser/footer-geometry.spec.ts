import { test, expect } from '@playwright/test';
import { measurePublicFooter } from '../fixtures/footer-geometry';

test('footer measurement keeps exact spacing across common movement', async ({
  page,
}) => {
  await page.setContent(`
    <style>body { margin: 0 } section { height: 40px }
    [data-feedback-id="shop-ad"] { display: block; margin-top: 24px; height: 30px }</style>
    <footer><div id="common">
      <section data-feedback-id="newsletter-signup"></section>
      <a data-feedback-id="shop-ad"></a>
    </div></footer>
  `);
  const before = await measurePublicFooter(page);
  const signup = await page
    .locator('[data-feedback-id="newsletter-signup"]')
    .boundingBox();
  if (!signup) throw new Error('Synthetic signup required');
  await page.locator('#common').evaluate((common) => {
    common.style.transform = 'translateY(5.046875px)';
  });
  const shop = await page.locator('[data-feedback-id="shop-ad"]').boundingBox();
  if (!shop) throw new Error('Synthetic shop banner required');
  const after = await measurePublicFooter(page);

  // Injected displacement proves the mixed-read defect, not its historical cause.
  expect(shop.y - signup.y - signup.height).toBe(29.046875);
  for (const snapshot of [before, after]) {
    expect(snapshot.shop.y - snapshot.signup.y - snapshot.signup.height).toBe(
      24,
    );
    expect(snapshot.shop.x).toBe(snapshot.signup.x);
    expect(snapshot.shop.width).toBe(snapshot.signup.width);
  }
  expect(after.signup.y - before.signup.y).toBe(5.046875);
  expect(after.shop.y - before.shop.y).toBe(5.046875);

  await page.locator('[data-feedback-id="shop-ad"]').evaluate((banner) => {
    banner.style.marginTop = '29.046875px';
  });
  const wrong = await measurePublicFooter(page);
  const wrongGap = wrong.shop.y - wrong.signup.y - wrong.signup.height;
  expect(wrongGap).toBe(29.046875);
  expect(() => {
    expect(wrongGap).toBe(24);
  }).toThrow();
});
