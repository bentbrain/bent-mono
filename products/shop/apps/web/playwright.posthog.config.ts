import "../../scripts/test-protected-config.mjs";
import { defineConfig } from "@playwright/test";
import localConfig from "./playwright.local.config";

export default defineConfig({
  ...localConfig,
  webServer: {
    ...localConfig.webServer,
    command: "node e2e/local/start.mjs",
    env: { E2E_POSTHOG_TEST: "1" },
  },
  projects: [{ name: "posthog", testMatch: "**/posthog.spec.ts", use: {
    browserName: "chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  } }],
});
