import vinext from "vinext";
import {locationDefines} from "./config/location";
import {releaseDefines} from "./config/release";
import {publicMetadata} from "./config/public-metadata";
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
    ...(isCodexSeatbeltSandbox
      ? {server: {watch: {useFsEvents: false, usePolling: true}}}
      : {}),
    define:{...locationDefines(mode, 'public'), ...releaseDefines()},
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
