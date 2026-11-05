"use client";
import { Button } from "@/app/_components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/_components/ui/dialog";
import { api } from "@/trpc/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

const NSFWPreferenceDialog = ({ userId }: { userId: string }) => {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [updating, setUpdating] = useState(false);
  const updateNSFWPref = api.user.updatePreferences.useMutation({
    onSettled: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const handlePreference = async (allow: boolean) => {
    setUpdating(true);
    try {
      await updateNSFWPref.mutateAsync({
        userId: userId,
        showNsfw: allow,
      });
    } catch (error) {
      console.error("Error updating NSFW preference", error);
    } finally {
      setUpdating(false);
    }
  };

  const handleOpenChange = async (open: boolean) => {
    if (!open) {
      await handlePreference(false);
    }
    setOpen(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="text-black">
        <DialogHeader>
          <DialogTitle>Show NSFW content?</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          You can change this later on your profile.
        </DialogDescription>
        <DialogFooter className="flex gap-3 sm:justify-end">
          <Button
            variant={"outline"}
            onClick={() => handlePreference(false)}
            disabled={updating}
          >
            No
          </Button>
          <Button
            variant={"outline"}
            onClick={() => handlePreference(true)}
            disabled={updating}
          >
            Yes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NSFWPreferenceDialog;
