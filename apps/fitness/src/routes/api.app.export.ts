import { createFileRoute } from "@tanstack/react-router";
import { handleExport } from "../server/app-api";
export const Route = createFileRoute("/api/app/export")({
  server: {
    handlers: {
      GET: ({ request }) => handleExport(request),
    },
  },
});
