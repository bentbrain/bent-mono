import { createFileRoute } from "@tanstack/react-router";
import { CameraLanding } from "@/components/camera-landing";
import { MobileOnlyGate } from "@/components/mobile-only-gate";
export const Route = createFileRoute("/create/")({
  component: () => (
    <div className="flex flex-1 flex-col pt-12">
      <MobileOnlyGate renderMobileFallback>
        <CameraLanding />
      </MobileOnlyGate>
    </div>
  ),
});
