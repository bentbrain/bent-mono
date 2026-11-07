"use client";
import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Trash2, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { api } from "@/trpc/react";
import { useRouter } from "next/navigation";
type Props = {
  collageId: number;
  userId: string;
} & React.ComponentProps<typeof DialogTrigger>;

function DeleteButton({ collageId, userId, ...props }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const router = useRouter();
  const utils = api.useUtils();
  const deleteCollage = api.collage.delete.useMutation({
    onSuccess: () => {
      void utils.collage.getAllPublic.invalidate();
      router.refresh();
      setIsOpen(false);
    },
    onError: () => {
      setDeleteError("The collage could not be deleted. Please try again.");
    },
    onSettled: () => {
      setIsDeleting(false);
    },
  });

  return (
    <Dialog open={isDeleting ? true : isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild {...props}>
        <Button
          className="border-red-500 text-red-500 hover:text-red-600"
          variant={"outline"}
        >
          Delete <Trash2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="text-black">
        <DialogHeader>
          <DialogTitle>Delete this collage?</DialogTitle>
          <DialogDescription>
            Your collage cannot be recovered once deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            disabled={isDeleting}
            variant="outline"
            onClick={() => setIsOpen(false)}
          >
            Cancel
          </Button>
          <Button
            className="border-red-500 text-red-500 hover:text-red-600"
            variant="outline"
            disabled={isDeleting}
            onClick={() => {
              setDeleteError(undefined);
              setIsDeleting(true);
              deleteCollage.mutate({ id: collageId, userId });
            }}
          >
            Delete
            {isDeleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
          {deleteError && (
            <p className="text-sm text-red-700" role="alert">
              {deleteError}
            </p>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DeleteButton;
