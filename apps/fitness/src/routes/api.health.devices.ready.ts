import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceReady } from "../server/devices";
export const Route = createFileRoute("/api/health/devices/ready")({
  server: {
    handlers: {
      GET: ({ request }) => handleDeviceReady(request),
    },
  },
});
