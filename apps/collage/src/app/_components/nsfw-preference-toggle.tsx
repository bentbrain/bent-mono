"use client";
import { api } from "@/trpc/react";
import { useRouter } from "next/navigation";
import React, { useState } from "react";
import { Button, type ButtonProps } from "./ui/button";
import { Switch } from "./ui/switch";

const NSFWToggle: React.FC<
  {
    prevPref: boolean;
    userId: string;
  } & ButtonProps
> = ({ prevPref, userId, ...props }) => {
  const router = useRouter();
  const [currentPref, setCurrentPref] = useState(prevPref);
  const [loading, setLoading] = useState(false);
  const updateNSFWPref = api.user.updatePreferences.useMutation({
    onSuccess: (preferences) => {
      setCurrentPref(preferences?.showNsfw ?? prevPref);
    },
    onSettled: () => {
      router.refresh();
    },
  });

  const handleToggle = async () => {
    setLoading(true);
    try {
      await updateNSFWPref.mutateAsync({
        userId,
        showNsfw: !currentPref,
      });
    } catch (error) {
      console.error("Error updating NSFW preference:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      onClick={handleToggle}
      variant="outline"
      disabled={loading}
      asChild
      {...props}
    >
      <div className="flex cursor-pointer items-center space-x-2">
        <span>Show NSFW content</span>
        <Switch loading={loading} checked={currentPref} />
      </div>
    </Button>
  );
};

export default NSFWToggle;
