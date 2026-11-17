import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
export default defineConfig({
  ...config,
  testMatch: "auth.spec.ts",
  timeout: 120000,
});
