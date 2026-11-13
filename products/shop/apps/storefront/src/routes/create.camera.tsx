import { createFileRoute } from "@tanstack/react-router";
import { CameraMobileRoute } from "@/components/camera-mobile-route";
export const Route = createFileRoute("/create/camera")({
  component: CameraMobileRoute,
});
