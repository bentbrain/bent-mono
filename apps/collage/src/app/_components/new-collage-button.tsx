import { Plus } from "lucide-react";
import Link from "next/link";
import { Button, type ButtonProps } from "./ui/button";
import { cn } from "@/lib/utils";

function NewCollageButton({
  showOnMobile = false,
  ...props
}: { showOnMobile?: boolean } & ButtonProps) {
  return (
    <Button
      className={cn(!showOnMobile && "hidden md:inline-flex")}
      variant={"outline"}
      asChild
      {...props}
    >
      <Link href={`/create`} prefetch={true}>
        New collage <Plus className="size-4" />
      </Link>
    </Button>
  );
}

export default NewCollageButton;
