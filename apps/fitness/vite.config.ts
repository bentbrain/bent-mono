import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

/** Signed-in sections load with the app so they open while offline. */
function accountSection(routeId: string) {
  return routeId === "/_app" || routeId.startsWith("/_app/");
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
  ],
  server: { port: 3025 },
});
