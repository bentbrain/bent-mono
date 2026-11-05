import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "dev";
if (!["dev", "build", "start"].includes(mode)) throw new Error("Expected dev, build or start.");
const serverArgs = mode === "build" ? [] : ["--hostname", "127.0.0.1", "--port", "4317"];

// Fixed placeholders override inherited app secrets. This subprocess alone gets
// the network fixture; regular dev/build/deploy commands cannot opt into it.
const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./preload.mjs", import.meta.url)),
  createRequire(import.meta.url).resolve("next/dist/bin/next"), mode, ...serverArgs], {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: "", VERCEL_ENV: "preview",
    PUBLIC_STORE_DOMAIN: "ci.myshopify.com", PUBLIC_STOREFRONT_API_TOKEN: "ci-public-token",
    PRIVATE_STOREFRONT_API_TOKEN: "ci-private-token", FOREVER_TEE_API_URL: "https://api.example.com",
    FOREVER_TEE_API_SHARED_SECRET: "ci-shared-secret-at-least-random", NEXT_PUBLIC_FOREVER_TEE_API_URL: "https://api.example.com",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
    TURNSTILE_TEST_MODE: "1", NEXT_TELEMETRY_DISABLED: "1", SHOP_ID: "", PUBLIC_STOREFRONT_ID: "",
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env["E2E_POSTHOG_TEST"] === "1" ? "phc_local_fixture" : "",
    NEXT_PUBLIC_POSTHOG_HOST: process.env["E2E_POSTHOG_TEST"] === "1" ? "https://analytics.example.com" : "",
    POSTHOG_CLI_API_KEY: "", POSTHOG_CLI_PROJECT_ID: "", POSTHOG_CLI_HOST: "",
  },
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
