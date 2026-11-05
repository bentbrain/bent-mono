import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const baseURL = process.env["E2E_BASE_URL"];
if (!baseURL) {
  throw new Error("E2E_BASE_URL must name a deployed bent.shop environment.");
}

const cameraFixture = resolve("e2e/fixtures/portrait-camera.y4m");
const protectionBypass = process.env["VERCEL_AUTOMATION_BYPASS_SECRET"];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL,
    extraHTTPHeaders: protectionBypass
      ? {
          "x-vercel-protection-bypass": protectionBypass,
          "x-vercel-set-bypass-cookie": "true",
        }
      : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      testMatch: ["**/purchase.spec.ts", "**/desktop-create.spec.ts", "**/search-indexing.spec.ts", "**/featured-products.spec.ts"],
      use: {
        browserName: "chromium",
        viewport: { height: 900, width: 1_440 },
      },
    },
    {
      name: "mobile-camera-chromium",
      testMatch: "**/create-mobile.spec.ts",
      use: {
        browserName: "chromium",
        hasTouch: true,
        isMobile: true,
        permissions: ["camera"],
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
        viewport: { height: 915, width: 412 },
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-video-capture=${cameraFixture}`,
          ],
        },
      },
    },
  ],
});
