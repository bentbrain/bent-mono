import { CanvasSkeleton } from "@/app/_components/canvas-skeleton";
import { api } from "@/trpc/server";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import CanvasWrapper from "../../_components/canvas-wrapper";

export default async function Home() {
  return (
    <main className="container mx-auto grid max-w-full place-items-center px-0 sm:px-4">
      <Suspense fallback={<CanvasSkeleton />}>
        <DynamicParts />
      </Suspense>
    </main>
  );
}

async function DynamicParts() {
  const { userId } = await auth();

  if (!userId) {
    return notFound();
  }

  const preferences = await api.user.getPreferences({ userId });

  const showTutorial = !preferences?.tutorialViewed;

  return <CanvasWrapper userId={userId} showTutorial={showTutorial} />;
}
