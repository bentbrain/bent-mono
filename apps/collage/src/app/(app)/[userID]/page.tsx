import CollageOptionsPopover from "@/app/_components/collage-options-popover";
import DownloadUrlButton from "@/app/_components/download-url-button";
import NewCollageButton from "@/app/_components/new-collage-button";
import NSFWToggle from "@/app/_components/nsfw-preference-toggle";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { api } from "@/trpc/server";
import { SignOutButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Suspense } from "react";

async function Page({ params }: { params: Promise<{ userID: string }> }) {
  return (
    <Card className="grid gap-6 p-4">
      <Suspense fallback={<UserDetailsSkeleton />}>
        <DynamicUserDetails params={params} />
      </Suspense>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Suspense fallback={<CollagesSkeletonList />}>
          <DynamicCollages params={params} />
        </Suspense>
      </div>
    </Card>
  );
}

export default Page;

async function DynamicUserDetails({
  params,
}: {
  params: Promise<{ userID: string }>;
}) {
  const { userID } = await params;

  if (!userID.startsWith("user_")) {
    return notFound();
  }

  const { userId: currentUserId } = await auth();
  const isOwner = currentUserId === userID;
  const [userDetails, preferences] = await Promise.all([
    api.user.getById({ userId: userID }),
    isOwner
      ? api.user.getPreferences({ userId: userID })
      : Promise.resolve(null),
  ]);

  if (!userDetails) {
    return notFound();
  }

  const displayName = [userDetails.firstName, userDetails.lastName]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col justify-between gap-4 border-2 border-black bg-white p-4 sm:flex-row sm:items-center">
      <div className="flex items-center gap-4">
        <Image
          src={userDetails.imageUrl}
          alt={displayName}
          className="rounded-full border border-black"
          width={50}
          height={50}
        />
        <p className="text-2xl">{displayName}</p>
      </div>
      {isOwner && (
        <div className="flex flex-col items-center gap-2 sm:flex-row">
          <NSFWToggle
            className="w-full sm:w-auto"
            prevPref={preferences?.showNsfw ?? false}
            userId={userID}
          />
          <Button className="w-full sm:w-auto" variant={"outline"} asChild>
            <SignOutButton />
          </Button>
        </div>
      )}
    </div>
  );
}

function UserDetailsSkeleton() {
  return (
    <div className="flex flex-col justify-between gap-4 border-2 border-black bg-white p-4 sm:flex-row sm:items-center">
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-full" />
        <Skeleton className="h-10 w-36" />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Skeleton className="h-10 w-full sm:w-36" />
        <Skeleton className="h-10 w-full sm:w-36" />
      </div>
    </div>
  );
}

async function DynamicCollages({
  params,
}: {
  params: Promise<{ userID: string }>;
}) {
  const { userID } = await params;

  // Add the same validation here
  if (!userID.startsWith("user_")) {
    return notFound();
  }

  const [collages, { userId: currentUserId }] = await Promise.all([
    api.collage.getAllByUserId({ userId: userID }),
    auth(),
  ]);
  const isOwner = currentUserId === userID;

  const collagesToShow = collages.filter((collage) =>
    isOwner ? true : collage.public,
  );

  return collagesToShow.length ? (
    collagesToShow.map((collage) => {
      return (
        <div
          key={collage.id}
          className="flex flex-col gap-2 border border-black bg-white p-3"
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-center text-sm uppercase text-gray-500">
              {new Date(collage.createdAt).toLocaleDateString()}
            </p>
            {isOwner ? (
              <CollageOptionsPopover
                collageId={collage.id}
                canvasUserId={collage.userId ?? ""}
                userId={userID}
                imageUrl={collage.imageUrl}
                isPublic={collage.public}
                refresh={true}
                size={"sm"}
              />
            ) : (
              <DownloadUrlButton url={collage.imageUrl} size={"sm"} />
            )}
          </div>
          <Image
            className="border border-black"
            width={400}
            height={400}
            src={collage.imageUrl}
            alt={collage.id.toString()}
            loading="lazy"
          />
        </div>
      );
    })
  ) : (
    <div className="col-span-full grid place-items-center">
      {isOwner ? (
        <NewCollageButton />
      ) : (
        <p className="text-center text-sm text-gray-500">No collages found.</p>
      )}
    </div>
  );
}

function CollagesSkeleton() {
  return (
    <div className="flex flex-col gap-2 border border-black bg-white p-3">
      <Skeleton className="ml-auto size-8" />
      <Skeleton className="aspect-square size-[400px] max-w-full" />
    </div>
  );
}

function CollagesSkeletonList() {
  return (
    <div className="col-span-full grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <CollagesSkeleton />
      <CollagesSkeleton />
      <CollagesSkeleton />
    </div>
  );
}
