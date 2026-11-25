import { defineConfig, devices } from "@playwright/test";

/** Synthetic Clerk keys for a server whose Clerk API is a closed local port. */
const configured = {
  VITE_CLERK_PUBLISHABLE_KEY:
    "pk_test_" + Buffer.from("example.invalid$").toString("base64"),
  CLERK_SECRET_KEY: "sk_test_" + "synthetic",
  CLERK_API_URL: "http://127.0.0.1:9",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:9/fitness",
  FITNESS_ALLOWED_EMAILS: "fitness-a+clerk_test@example.com",
  FITNESS_MCP_URL: "http://127.0.0.1:3026/api/mcp",
  FITNESS_DEVICE_ENROLLMENT: "",
  FITNESS_DEVICE_CLIENT_IDS: "",
};
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["public.spec.ts", "bearer.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:3025",
    channel: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile",
      testMatch: "public.spec.ts",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
    {
      name: "desktop",
      testMatch: "public.spec.ts",
      use: { viewport: { width: 1280, height: 900 } },
    },
    {
      name: "configured",
      testMatch: "bearer.spec.ts",
      use: { baseURL: "http://127.0.0.1:3026" },
    },
  ],
  webServer: [
    {
      command: "bun run dev",
      url: "http://localhost:3025",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: "bunx vite --host 127.0.0.1 --port 3026 --strictPort",
      url: "http://127.0.0.1:3026/manifest.webmanifest",
      reuseExistingServer: false,
      timeout: 60000,
      env: { ...inherited, ...configured },
    },
  ],
  reporter: "list",
});
