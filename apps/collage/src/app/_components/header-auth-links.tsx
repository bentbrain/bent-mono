import { Show } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { Images } from "lucide-react";
import Link from "next/link";
import NewCollageButton from "./new-collage-button";
import { Button } from "./ui/button";
import SignInButtonWrapper from "./sign-in-button";

async function HeaderAuthLinks() {
  const { userId } = await auth();

  return (
    <>
      <Show when="signed-out">
        <SignInButtonWrapper variant={"outline"} />
      </Show>
      <Show when="signed-in">
        <NewCollageButton />
        <Button variant={"outline"} asChild>
          <Link href={`/${userId}`} prefetch={true}>
            My collages <Images className="size-4" />
          </Link>
        </Button>
      </Show>
    </>
  );
}

export default HeaderAuthLinks;
