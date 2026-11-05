import type { Page } from '@playwright/test';

export function measurePublicFooter(page: Page) {
  return page.evaluate(() => {
    const footers = document.querySelectorAll('body > footer');
    const signups = document.querySelectorAll(
      'body > footer [data-feedback-id="newsletter-signup"]',
    );
    const shops = document.querySelectorAll(
      'body > footer [data-feedback-id="shop-ad"]',
    );
    const footer = footers[0];
    const signup = signups[0];
    const shop = shops[0];
    if (
      footers.length !== 1 ||
      signups.length !== 1 ||
      shops.length !== 1 ||
      !footer ||
      !signup ||
      !shop
    )
      throw new Error('Unique public footer, signup and shop banner required');

    function box(element: Element) {
      const { x, y, top, bottom, width, height } =
        element.getBoundingClientRect();
      return { x, y, top, bottom, width, height };
    }

    // Keep every related rectangle and document metric in one layout state.
    return {
      signup: box(signup),
      shop: box(shop),
      footer: box(footer),
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}
