import { CameraLanding } from "@/components/camera-landing";
import { MobileOnlyGate } from "@/components/mobile-only-gate";

export default function CreatePage() {
  return (
    <div className="flex flex-1 flex-col pt-12">
      <MobileOnlyGate renderMobileFallback>
        <CameraLanding />
      </MobileOnlyGate>
    </div>
  );
}
