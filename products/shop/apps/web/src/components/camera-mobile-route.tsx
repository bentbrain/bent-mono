"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { preloadCreatedDraft } from "@/client/draft-handoff";
import { CameraPermissionLauncher } from "@/components/camera-permission-launcher";
import { MobileOnlyGate } from "@/components/mobile-only-gate";
import { designPath } from "@/lib/products";

export function CameraMobileRoute() {
  const router = useRouter();
  const openDraft = useCallback((designId: string) => {
    preloadCreatedDraft(designId);
    router.replace(`${designPath(designId)}?camera=1`);
  }, [router]);

  return (
    <MobileOnlyGate renderMobileFallback>
      <CameraPermissionLauncher onDraftCreated={openDraft} />
    </MobileOnlyGate>
  );
}
