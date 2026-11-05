import { readFileSync } from "node:fs";
export function validationEnvironment(env = process.env) {
  return {
    ...env,
    SHOP_PROTECTED_CONFIG_JSON: readFileSync(new URL("./protected-config.fixtures.json", import.meta.url), "utf8"),
    // Validation produces fixture builds, never deployable release artifacts.
    // Keep commit identity hashing for actual storefront builds.
    GITHUB_SHA: "",
    VERCEL_GIT_COMMIT_SHA: "",
    PUBLIC_STORE_DOMAIN: "ci.myshopify.com",
    PUBLIC_STOREFRONT_API_TOKEN: "ci-public-token",
    PRIVATE_STOREFRONT_API_TOKEN: "ci-private-token",
    FOREVER_TEE_API_URL: "https://api.example.com",
    FOREVER_TEE_API_SHARED_SECRET: "ci-shared-secret-at-least-random",
    NEXT_PUBLIC_FOREVER_TEE_API_URL: "https://api.example.com",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "",
    NEXT_PUBLIC_POSTHOG_HOST: "",
    POSTHOG_CLI_API_KEY: "",
    POSTHOG_CLI_PROJECT_ID: "",
    POSTHOG_CLI_HOST: "",
    TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
    TURNSTILE_TEST_MODE: "1",
  };
}
