"use client";

import { DesignEditorMobileContent } from "@/components/design-editor-mobile-content";

export function DesignMobileRoute({
  cameraLaunch,
  uploadLaunch = false,
  id,
}: {
  cameraLaunch: boolean;
  uploadLaunch?: boolean;
  id: string;
}) {
  return <DesignEditorMobileContent cameraLaunch={cameraLaunch} uploadLaunch={uploadLaunch} id={id} />;
}
