import { PUBLIC_FEED_PAGE_SIZE } from "@/lib/public-feed";
import { api, HydrateClient } from "@/trpc/server";
import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";
import InfiniteCollages from "../_components/infinite-collages";
import { Card } from "../_components/ui/card";
import { Skeleton } from "../_components/ui/skeleton";

function Page() {
  return (
    <div className="container mx-auto grid place-items-center">
      <Card className="grid w-full place-items-center gap-8 p-4 md:w-auto">
        <Suspense fallback={<CollageSkeletonList />}>
          <DynamicParts />
        </Suspense>
      </Card>
    </div>
  );
}

export default Page;

async function DynamicParts() {
  const feedPrefetch = api.collage.getAllPublic.prefetchInfinite({
    limit: PUBLIC_FEED_PAGE_SIZE,
  });
  const { userId } = await auth();

  const preferences = userId ? await api.user.getPreferences({ userId }) : null;

  await feedPrefetch;

  return (
    <HydrateClient>
      <InfiniteCollages
        currentUserId={userId ?? ""}
        showNsfw={preferences?.showNsfw ?? false}
      />
    </HydrateClient>
  );
}

function CollageSkeleton() {
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex w-full items-end justify-between">
        <Skeleton className="h-14 w-36" />
        <Skeleton className="h-10 w-10" />
      </div>
      <Skeleton className="aspect-square w-full md:w-[550px]" />
    </div>
  );
}

function CollageSkeletonList() {
  const collages = Array.from({ length: 5 }, (_, index) => (
    <CollageSkeleton key={index} />
  ));
  return collages;
}
