import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceEnroll } from "../server/devices";
export const Route = createFileRoute("/api/health/devices")({
  server: {
    handlers: {
      POST: ({ request }) => handleDeviceEnroll(request),
    },
  },
});
