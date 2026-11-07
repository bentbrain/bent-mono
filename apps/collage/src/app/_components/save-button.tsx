"use client";

import { api } from "@/trpc/react";
import { jsonValueSchema } from "@/types/json";
import { useUploadThing } from "@/utils/uploadthing";
import { type Canvas, type FabricObject } from "fabric";
import { CheckCircle, Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useState,
} from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogTitle,
  DialogHeader,
  DialogContent,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import PublicButton from "./public-button";
type Props = {
  userId: string;
  fabricCanvasRef: RefObject<Canvas | null>;
  hasChanges: boolean;
  setHasChanges: Dispatch<SetStateAction<boolean>>;
  canvasId?: number;
};

function containsNSFW(objects: FabricObject[]): boolean {
  if (!objects || !Array.isArray(objects)) {
    return false;
  }

  return objects.some((obj) => {
    const isNsfw = "isNsfw" in obj ? obj.isNsfw : undefined;
    const src =
      "src" in obj && typeof obj.src === "string" ? obj.src : undefined;
    const alt =
      "alt" in obj && typeof obj.alt === "string" ? obj.alt : undefined;
    if (isNsfw === true) return true;
    if (src?.toLowerCase().includes("nsfw")) return true;
    if (alt?.toLowerCase().includes("nsfw")) return true;
    return false;
  });
}

function getSaveErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Your collage could not be saved. Please try again.";
  }

  const message = error.message.toLowerCase();

  if (message.includes("invalid token") || message.includes("missing token")) {
    return "The image service is not configured correctly. Please try again later.";
  }

  if (message.includes("file size") || message.includes("too large")) {
    return "Your collage image is too large to upload. Try removing a few images.";
  }

  if (
    message.includes("unauthorized") ||
    message.includes("not authenticated")
  ) {
    return "Your session has expired. Please sign in again before saving.";
  }

  return "Your collage could not be saved. Please try again.";
}

function SaveButton({
  userId,
  fabricCanvasRef,
  canvasId,
  hasChanges,
  setHasChanges,
}: Props) {
  const router = useRouter();
  const utils = api.useUtils();
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const [publicPromptOpen, setPublicPromptOpen] = useState(false);
  const [newCanvasId, setNewCanvasId] = useState<number | undefined>(undefined);

  const openSavedCollage = (collageId: number) => {
    router.push(`/${userId}/collage/${collageId}`);
  };

  const handleSaved = () => {
    setIsSaved(true);
    setPublicPromptOpen(true);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setPublicPromptOpen(false);
      if (newCanvasId !== undefined) {
        openSavedCollage(newCanvasId);
      }
    }
  };

  // Move the hook call here (top level of the component)
  const createCollage = api.collage.create.useMutation({
    onSuccess: (data) => {
      setHasChanges(false);
      setNewCanvasId(data.id);
      router.refresh();
      void utils.collage.getAllPublic.invalidate();
      handleSaved();
    },
  });
  const updateCollage = api.collage.update.useMutation({
    onSuccess: () => {
      setHasChanges(false);
      setIsSaved(true);
      router.refresh();
      void utils.collage.getAllPublic.invalidate();
      setTimeout(() => {
        setIsSaved(false);
      }, 3000);
    },
  });
  const prepareRenderUpload = api.collage.prepareRenderUpload.useMutation();

  const { startUpload } = useUploadThing("imageUploader", {
    onUploadError: (error: Error) => {
      console.error("Upload error:", error);
      setSaveError(getSaveErrorMessage(error));
    },
  });

  const uploadImage = async (canvas: Canvas): Promise<string> => {
    const activeObject = canvas.getActiveObject();
    const objects = canvas.getObjects();
    const originalBorders = objects.map((obj) => ({
      obj,
      hasControls: obj.hasControls,
      hasBorders: obj.hasBorders,
      selectable: obj.selectable,
    }));
    let blob: Blob | null = null;

    try {
      canvas.discardActiveObject();
      objects.forEach((obj) => {
        obj.hasControls = false;
        obj.hasBorders = false;
        obj.selectable = false;
      });
      canvas.renderAll();

      const desiredResolution = 1080;
      const multiplier = desiredResolution / canvas.getWidth();
      blob = await canvas.toBlob({
        format: "jpeg",
        quality: 0.92,
        multiplier,
      });
    } finally {
      originalBorders.forEach(
        ({ obj, hasControls, hasBorders, selectable }) => {
          obj.hasControls = hasControls;
          obj.hasBorders = hasBorders;
          obj.selectable = selectable;
        },
      );
      if (activeObject) {
        canvas.setActiveObject(activeObject);
      }
      canvas.renderAll();
    }

    if (!blob) {
      throw new Error("The collage image could not be generated.");
    }

    const file = new File([blob], `maya-collage-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });

    const uploadTarget = await prepareRenderUpload.mutateAsync();
    if (uploadTarget.provider === "uploadthing") {
      const res = await startUpload([file]);
      if (!res?.[0]) throw new Error("Upload failed");
      return res[0].ufsUrl;
    }

    if (file.size > uploadTarget.maxBytes) {
      throw new Error("The collage image is too large to upload");
    }
    const response = await fetch(uploadTarget.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": uploadTarget.contentType },
      body: file,
    });
    if (!response.ok) {
      throw new Error(`R2 upload failed with status ${response.status}`);
    }
    return uploadTarget.publicUrl;
  };

  const handleSaveCanvas = async () => {
    if (!fabricCanvasRef.current) {
      setSaveError("The collage is still loading. Please try again.");
      return;
    }

    setIsSaving(true);
    setIsSaved(false);
    setSaveError(undefined);
    const canvas = fabricCanvasRef.current;

    const containsNsfw = containsNSFW(canvas.getObjects());

    try {
      // Generate image from canvas and upload it
      const imageUrl = await uploadImage(canvas);

      // Get canvas JSON data and include background
      const serializedCanvas: unknown = JSON.parse(
        JSON.stringify(
          canvas.toObject(["backgroundImage", "src", "alt", "isNsfw"]),
        ),
      );
      const jsonData = jsonValueSchema.parse(serializedCanvas);

      // Use the mutation hook to save the collage
      if (canvasId) {
        await updateCollage.mutateAsync({
          id: canvasId,
          collageJson: jsonData,
          userId,
          imageUrl,
          nsfw: containsNsfw,
        });
      } else {
        await createCollage.mutateAsync({
          userId,
          collageJson: jsonData,
          imageUrl,
          nsfw: containsNsfw,
        });
      }

      return { success: true, imageUrl };
    } catch (error) {
      console.error("Failed to save canvas:", error);
      setSaveError(getSaveErrorMessage(error));
      return { success: false, error };
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Button
        onClick={async () => {
          await handleSaveCanvas();
        }}
        variant={"outline"}
        data-joyride="save-button"
        className="m-0 text-sm"
        disabled={!hasChanges || isSaving}
      >
        Save
        {isSaving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isSaved ? (
          <CheckCircle className="h-4 w-4" />
        ) : (
          <Save className="h-4 w-4" />
        )}
      </Button>
      {isSaved && !publicPromptOpen && (
        <p className="sr-only" role="status">
          Collage saved.
        </p>
      )}
      {saveError && (
        <p className="text-xs text-red-700" role="alert">
          {saveError}
        </p>
      )}
      <Dialog open={publicPromptOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="text-left text-black">
          <DialogHeader>
            <DialogTitle>Collage saved</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Choose &quot;Public&quot; to share it on the home page.
          </DialogDescription>
          <DialogFooter className="flex gap-3 sm:justify-end">
            <Button
              onClick={() => {
                setPublicPromptOpen(false);
                if (newCanvasId !== undefined) {
                  openSavedCollage(newCanvasId);
                }
              }}
              variant={"outline"}
            >
              Keep private
            </Button>
            <PublicButton
              isPublic={false}
              canvasId={newCanvasId ?? 0}
              userId={userId}
              refresh={true}
              onSuccess={() => {
                if (newCanvasId !== undefined) {
                  openSavedCollage(newCanvasId);
                }
              }}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default SaveButton;
