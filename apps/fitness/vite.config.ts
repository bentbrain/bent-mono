import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import type { Plugin } from "vite";

/** Signed-in sections load with the app so they open while offline. */
function accountSection(routeId: string) {
  return routeId === "/_app" || routeId.startsWith("/_app/");
}

/**
 * Fails a production build whose browser bundle reaches the database driver.
 * The driver needs Node's Buffer, so a browser that loads it stops before the
 * app starts.
 */
function serverOnlyModules(): Plugin {
  return {
    name: "fitness-server-only-modules",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    load(id) {
      if (/[\\/]node_modules[\\/]postgres[\\/]/.test(id))
        this.error(
          `The browser bundle imports the database driver (${id}). Move database access out of modules that client code imports.`,
        );
    },
  };
}

export default defineConfig({
  plugins: [
    tanstackStart({
      router: {
        codeSplittingOptions: {
          splitBehavior: ({ routeId }) =>
            accountSection(routeId) ? [] : undefined,
        },
      },
    }),
    nitro(),
    react(),
    serverOnlyModules(),
  ],
  server: { port: 3025 },
});
