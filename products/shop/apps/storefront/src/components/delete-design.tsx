"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { deleteDesign, getDesign } from "@/client/design-api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const buttonClass =
  "min-h-11 rounded-none border border-primary px-4 font-mono text-xs font-bold text-primary shadow-none hover:bg-primary hover:text-primary-foreground";

export function DeleteDesign({ designId }: { designId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const ownership = useQuery({
    queryKey: ["design-owner", designId],
    queryFn: () => getDesign(designId),
    retry: false,
  });
  const deletion = useMutation({
    mutationFn: () => deleteDesign(designId),
    onSuccess: () => {
      queryClient.clear();
      // Drop prefetched product pages and any preserved editor state as well.
      window.location.replace("/");
    },
  });

  if (!ownership.data?.finalized) return null;

  return (
    <>
      <button
        className="min-h-11 self-start text-center text-[0.58rem] font-normal uppercase underline underline-offset-4"
        onClick={() => {
          deletion.reset();
          setOpen(true);
        }}
        type="button"
      >
        Delete
      </button>
      <AlertDialog
        onOpenChange={(next) => {
          if (!deletion.isPending) setOpen(next);
        }}
        open={open}
      >
        <AlertDialogContent className="rounded-none border border-primary bg-background font-mono text-primary ring-0 motion-reduce:animate-none">
          <AlertDialogTitle>delete</AlertDialogTitle>
          <AlertDialogDescription className="text-xs leading-5 text-primary">
            this cannot be undone
          </AlertDialogDescription>
          {deletion.isError ? (
            <p className="text-xs" role="alert">
              The design couldn&apos;t be deleted. Please try again.
            </p>
          ) : null}
          <div className="flex justify-end gap-3">
            <AlertDialogCancel
              className={buttonClass}
              disabled={deletion.isPending}
            >
              cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className={`${buttonClass} bg-primary text-primary-foreground hover:bg-background hover:text-primary`}
              disabled={deletion.isPending}
              onClick={(event) => {
                event.preventDefault();
                deletion.mutate();
              }}
            >
              {deletion.isPending ? "deleting…" : "delete"}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
