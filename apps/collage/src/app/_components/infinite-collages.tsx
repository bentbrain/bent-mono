"use client";

import { PUBLIC_FEED_PAGE_SIZE } from "@/lib/public-feed";
import { api, type RouterOutputs } from "@/trpc/react";
import Image from "next/image";
import Link from "next/link";
import CollageOptionsPopover from "./collage-options-popover";
import { InfiniteScrollTrigger } from "./infinite-scroll-trigger";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import NewCollageButton from "./new-collage-button";

type Collage = RouterOutputs["collage"]["getAllPublic"]["items"][number];

interface InfiniteCollagesProps {
  currentUserId: string;
  showNsfw: boolean;
}

export default function InfiniteCollages({
  currentUserId,
  showNsfw,
}: InfiniteCollagesProps) {
  // Use tRPC's useInfiniteQuery for efficient infinite scrolling
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    api.collage.getAllPublic.useInfiniteQuery(
      {
        limit: PUBLIC_FEED_PAGE_SIZE,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    );

  // Filter collages based on NSFW preferences and ensure type safety
  const filteredCollages =
    data?.pages.flatMap((page) =>
      page.items.filter((collage) => {
        if (showNsfw) {
          return true;
        }
        return !collage.nsfw;
      }),
    ) ?? [];

  if (filteredCollages.length === 0 && !isLoading) {
    return null;
  }

  return (
    <>
      {/* Render collages */}
      {filteredCollages.map((collage, index) => (
        <CollageItem
          key={collage.id}
          collage={collage}
          currentUserId={currentUserId}
          preloadImage={index === 0}
        />
      ))}

      {/* Loading indicator */}
      {(isLoading || isFetchingNextPage) && <CollageSkeleton />}

      {/* Infinite scroll trigger */}
      {hasNextPage && (
        <InfiniteScrollTrigger
          onInView={() => void fetchNextPage()}
          hasNextPage={true}
          isFetchingNextPage={isFetchingNextPage}
        />
      )}

      {/* No more content message */}
      {!hasNextPage && filteredCollages.length > 0 && (
        <div className="grid place-items-center">
          <NewCollageButton showOnMobile={true} />
        </div>
      )}
    </>
  );
}

// Helper component to display a collage with user info
function CollageItem({
  collage,
  currentUserId,
  preloadImage,
}: {
  collage: Collage;
  currentUserId: string;
  preloadImage: boolean;
}) {
  const { userId } = collage;
  const { user } = collage;

  return (
    <div className="flex flex-col gap-2">
      <div className="space-between flex items-end gap-3">
        {user && userId ? (
          <Button
            className="mr-auto flex h-auto items-center gap-3 hover:bg-white"
            variant={"outline"}
            asChild
          >
            <Link href={`/${userId}`}>
              <Image
                width={30}
                height={30}
                src={user.imageUrl}
                alt={user.firstName ?? "Collage creator"}
                className="rounded-full"
                sizes="30px"
              />
              <div className="flex flex-col">
                <p>{user.firstName ?? "Collage creator"}</p>
                <p className="text-xs text-stone-500">
                  {new Date(collage.createdAt).toLocaleDateString()}
                </p>
              </div>
            </Link>
          </Button>
        ) : (
          <p className="mr-auto text-xs text-stone-500">
            {new Date(collage.createdAt).toLocaleDateString()}
          </p>
        )}
        <CollageOptionsPopover
          collageId={collage.id}
          canvasUserId={userId ?? ""}
          userId={currentUserId}
          imageUrl={collage.imageUrl}
          isPublic={collage.public}
          refresh={true}
        />
      </div>
      <Image
        width={550}
        height={550}
        src={collage.imageUrl}
        alt={collage.id.toString()}
        className="border-2 border-black"
        quality={60}
        sizes="(min-width: 768px) 550px, calc(100vw - 56px)"
        preload={preloadImage}
      />
    </div>
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
