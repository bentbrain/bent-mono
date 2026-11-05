import vinext from "vinext";
import {locationDefines} from "./build/location";
import {publicMetadata} from "./build/public-metadata";
import { defineConfig } from "vite";

const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({mode}) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    define:locationDefines(mode),
    plugins: [
      publicMetadata(),
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        configPath: "./wrangler.jsonc",
      }),
    ],
  };
});
