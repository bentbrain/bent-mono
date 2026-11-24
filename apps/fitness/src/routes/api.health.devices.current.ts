import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceRevoke } from "../server/devices";
export const Route = createFileRoute("/api/health/devices/current")({
  server: {
    handlers: {
      DELETE: ({ request }) => handleDeviceRevoke(request),
    },
  },
});
