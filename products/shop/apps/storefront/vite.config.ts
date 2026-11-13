import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  publicDir: "../web/public",
  build: { sourcemap: true },
  plugins: [
    {
      name: "shop-shared-source",
      enforce: "pre",
      resolveId(id) {
        if (!id.startsWith("@/")) return;
        for (const base of ["./src/", "../web/src/"]) {
          for (const extension of [
            "",
            ".ts",
            ".tsx",
            "/index.ts",
            "/index.tsx",
          ]) {
            const path = fileURLToPath(
              new URL(`${base}${id.slice(2)}${extension}`, import.meta.url),
            );
            if (existsSync(path) && /\.(tsx?|json|css)$/.test(path))
              return path;
          }
        }
      },
    },
    cloudflare({ viteEnvironment: { name: "ssr" }, persistState: false }),
    tanstackStart(),
    tailwindcss(),
    react(),
  ],
});
