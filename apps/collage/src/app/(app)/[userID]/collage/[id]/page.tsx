import { CanvasSkeleton } from "@/app/_components/canvas-skeleton";
import CanvasWrapper from "@/app/_components/canvas-wrapper";
import { api } from "@/trpc/server";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

async function Page({
  params,
}: {
  params: Promise<{ userID: string; id: string }>;
}) {
  return (
    <Suspense fallback={<CanvasSkeleton />}>
      <DynamicCollage params={params} />
    </Suspense>
  );
}

export default Page;

async function DynamicCollage({
  params,
}: {
  params: Promise<{ userID: string; id: string }>;
}) {
  const [{ id, userID }, { userId: currentUserId }] = await Promise.all([
    params,
    auth(),
  ]);
  const collageId = Number(id);

  if (
    currentUserId !== userID ||
    !Number.isSafeInteger(collageId) ||
    collageId < 1
  ) {
    return notFound();
  }

  const [preferences, collage] = await Promise.all([
    api.user.getPreferences({ userId: currentUserId }),
    api.collage.getById({ id: collageId }),
  ]);

  if (collage?.userId !== currentUserId) {
    return notFound();
  }

  const showTutorial = !preferences?.tutorialViewed;

  return (
    <CanvasWrapper
      userId={userID}
      collage={collage}
      showTutorial={showTutorial}
    />
  );
}
