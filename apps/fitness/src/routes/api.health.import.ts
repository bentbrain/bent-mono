import { createFileRoute } from "@tanstack/react-router";
import { handleHealthImport } from "../server/health";
export const Route = createFileRoute("/api/health/import")({
  server: {
    handlers: {
      POST: ({ request }) => handleHealthImport(request),
    },
  },
});
