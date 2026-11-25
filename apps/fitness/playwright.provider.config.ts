import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
const [server] = [config.webServer].flat();
export default defineConfig({
  ...config,
  testMatch: ["auth.spec.ts", "navigation.spec.ts"],
  // The provider checks run on the browser projects against the main server.
  projects: config.projects
    ?.filter((project) => project.name !== "configured")
    .map((project) => ({ ...project, testMatch: undefined })),
  webServer: server,
  timeout: 120000,
});
