"use client";
import { api } from "@/trpc/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, type ButtonProps } from "./ui/button";
import { Switch } from "./ui/switch";

type PublicButtonProps = {
  isPublic: boolean;
  canvasId: number;
  userId: string;
  refresh?: boolean;
  onSuccess?: () => void;
} & ButtonProps;

function PublicButton({
  isPublic,
  canvasId,
  userId,
  refresh,
  onSuccess,
  ...props
}: PublicButtonProps) {
  const router = useRouter();
  const utils = api.useUtils();
  const [currentPublic, setCurrentPublic] = useState(isPublic);
  const [loading, setLoading] = useState(false);
  const [updateError, setUpdateError] = useState<string>();

  const updateCollage = api.collage.update.useMutation({
    onSuccess: () => {
      setCurrentPublic((prev) => !prev);
      void utils.collage.getAllPublic.invalidate();
      if (refresh) {
        router.refresh();
      }
      onSuccess?.();
    },
    onError: () => {
      setUpdateError("Visibility could not be updated. Please try again.");
    },
    onSettled: () => {
      setLoading(false);
    },
  });

  const handlePublicChange = () => {
    setUpdateError(undefined);
    setLoading(true);
    updateCollage.mutate({ id: canvasId, userId, public: !currentPublic });
  };

  return (
    <div className="grid gap-1">
      <Button
        onClick={handlePublicChange}
        className="cursor-pointer"
        asChild
        variant={"outline"}
        {...props}
      >
        <div>
          Public
          <Switch loading={loading} checked={currentPublic} />
        </div>
      </Button>
      {updateError && (
        <p className="text-xs text-red-700" role="alert">
          {updateError}
        </p>
      )}
    </div>
  );
}

export default PublicButton;
