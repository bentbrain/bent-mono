import CollageOptionsPopover from "@/app/_components/collage-options-popover";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { api } from "@/trpc/server";
import { checkRole } from "@/utils/roles";
import { auth, clerkClient } from "@clerk/nextjs/server";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

async function Page() {
  const isAdmin = await checkRole("admin");
  const { userId } = await auth();
  if (!isAdmin) {
    redirect("/");
  }

  const collages = await api.collage.getAll({});
  const client = await clerkClient();
  const userIds = [...new Set(collages.flatMap(({ userId }) => userId ?? []))];
  const users =
    userIds.length > 0
      ? (
          await client.users.getUserList({
            userId: userIds,
            limit: userIds.length,
          })
        ).data
      : [];
  const usersById = new Map(users.map((user) => [user.id, user]));

  const collagesWithUserInfo = collages.flatMap((collage) => {
    if (!collage.userId) return [];
    const user = usersById.get(collage.userId);
    return user ? [{ ...collage, userId: collage.userId, user }] : [];
  });

  return (
    <div className="container mx-auto grid place-items-center">
      <Card className="grid place-items-center gap-8 p-4">
        {collagesWithUserInfo.map((collage) => (
          <div key={collage.id} className="flex flex-col gap-2">
            <div className="space-between flex items-end gap-3">
              <Button
                className="mr-auto flex h-auto items-center gap-3 hover:bg-white"
                variant={"outline"}
                asChild
              >
                <Link href={`/${collage.userId}`}>
                  <Image
                    width={30}
                    height={30}
                    src={collage.user.imageUrl}
                    alt={collage.id.toString()}
                    className="rounded-full"
                  />
                  <div className="flex flex-col">
                    <p>{collage.user.firstName}</p>
                    <p className="text-xs text-stone-500">
                      {collage.createdAt.toLocaleDateString()}
                    </p>
                  </div>
                </Link>
              </Button>
              <CollageOptionsPopover
                collageId={collage.id}
                canvasUserId={collage.userId}
                userId={userId ?? ""}
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
            />
          </div>
        ))}
      </Card>
    </div>
  );
}

export default Page;
