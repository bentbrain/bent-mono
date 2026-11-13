"use client";

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { preloadCreatedDraft } from "@/client/draft-handoff";
import { CameraPermissionLauncher } from "@/components/camera-permission-launcher";
import { MobileOnlyGate } from "@/components/mobile-only-gate";

export function CameraMobileRoute() {
  const navigate = useNavigate();
  const openDraft = useCallback(
    (designId: string) => {
      preloadCreatedDraft(designId);
      void navigate({
        to: "/design/$id",
        params: { id: designId },
        search: { upload: false, camera: true },
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <MobileOnlyGate renderMobileFallback>
      <CameraPermissionLauncher onDraftCreated={openDraft} />
    </MobileOnlyGate>
  );
}
