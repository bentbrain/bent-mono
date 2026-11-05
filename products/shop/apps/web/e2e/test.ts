import { expect, test as base } from "@playwright/test";

const LOCAL_SHOPIFY_CONSENT_FIXTURE = `
(() => {
  const customerPrivacy = window.Shopify?.customerPrivacy;
  if (!customerPrivacy) return;
  customerPrivacy.analyticsProcessingAllowed = () => false;
  customerPrivacy.currentVisitorConsent = () => ({
    analytics: "no",
    marketing: "no",
    preferences: "no",
    saleOfData: "no",
  });
  customerPrivacy.setTrackingConsent = (_consent, callback) => callback({});
  customerPrivacy.shouldShowBanner = () => false;
})();
`;

// Deployed tests retain their real upstreams. Only the dedicated local origin
// uses fixtures; unexpected browser network requests fail the local test.
export const test = base.extend({
  page: async ({ page, baseURL }, runTest) => {
    const unexpected: string[] = [];
    if (baseURL === "http://127.0.0.1:4317" || baseURL === "http://localhost:4317") {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === baseURL || !["http:", "https:"].includes(url.protocol)) return route.continue();
        if (url.hostname === "cdn.shopify.com" && url.pathname === "/shopifycloud/consent-tracking-api/v0.2/consent-tracking-api.js") {
          return route.fulfill({ contentType: "application/javascript", body: LOCAL_SHOPIFY_CONSENT_FIXTURE });
        }
        if (url.hostname === "cdn.shopify.com" && ["/storefront/standard-actions.js", "/storefront/analytics/shopify.js", "/shopifycloud/perf-kit/shopify-perf-kit-spa.min.js", "/storefront/standard-events.js"].includes(url.pathname)) {
          return route.fulfill({ contentType: "application/javascript", body: "/* local consent/analytics fixture */" });
        }
        unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort("blockedbyclient");
      });
    }
    await runTest(page);
    expect(unexpected, "Unexpected external requests in local browser test").toEqual([]);
  },
});
export { expect };
