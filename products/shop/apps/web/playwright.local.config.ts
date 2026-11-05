import "../../scripts/test-protected-config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  maxFailures: process.env["CI"] ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4317",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: process.env["E2E_LOCAL_PRODUCTION"] === "1"
      ? "node e2e/local/start.mjs start"
      : "node e2e/local/start.mjs",
    url: "http://127.0.0.1:4317/create",
    reuseExistingServer: false,
    timeout: 90_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
  projects: [
    { name: "local-desktop", testMatch: ["**/desktop-create.spec.ts", "**/local-product.spec.ts", "**/local-cart-empty.spec.ts", "**/search-indexing.spec.ts", "**/featured-products.spec.ts", "**/local-order-management.spec.ts", "**/local-saved-designs.spec.ts"],
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "local-order-mobile", testMatch: "**/local-order-management.spec.ts", use: {browserName: "chromium", isMobile: true, hasTouch: true, viewport: {width: 390, height: 844}} },
    { name: "local-mobile", testMatch: ["**/local-browser-preview.spec.ts", "**/local-image-upload.spec.ts", "**/local-entry.spec.ts", "**/local-cart-empty.spec.ts", "**/local-camera-performance.spec.ts", "**/local-retake.spec.ts", "**/local-camera-preview.spec.ts", "**/local-saved-designs.spec.ts"],
      use: { browserName: "chromium", isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } } },
  ],
});
