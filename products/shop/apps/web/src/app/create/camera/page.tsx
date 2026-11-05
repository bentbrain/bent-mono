import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CameraPreparingPage } from "@/components/camera-preparing";
import { CameraMobileRoute } from "@/components/camera-mobile-route";
import { hasContentDeclaration } from "@/server/content-declaration";

export default function CameraPermissionPage() {
  return (
    <Suspense fallback={<CameraPreparingPage />}>
      <DeclaredCameraPage />
    </Suspense>
  );
}

async function DeclaredCameraPage() {
  if (!await hasContentDeclaration()) redirect("/create");
  return <CameraMobileRoute />;
}
