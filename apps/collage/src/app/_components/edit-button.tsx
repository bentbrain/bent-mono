import { Pencil } from "lucide-react";
import React from "react";
import { Button, type ButtonProps } from "./ui/button";
import Link from "next/link";

type EditButtonProps = {
  userId: string;
  collageID: number;
} & ButtonProps;

function EditButton({ userId, collageID, ...props }: EditButtonProps) {
  return (
    <Button variant={"outline"} asChild {...props}>
      <Link href={`/${userId}/collage/${collageID}`}>
        Edit <Pencil className="size-4" />
      </Link>
    </Button>
  );
}

export default EditButton;
