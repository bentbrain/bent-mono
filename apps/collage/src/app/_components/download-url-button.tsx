"use client";

import { Button, type ButtonProps } from "@/app/_components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { saveImageBlob } from "./download-utils";

type DownloadUrlButtonProps = {
  url: string;
} & ButtonProps;

function DownloadUrlButton({ url, ...props }: DownloadUrlButtonProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();

  async function handleDownload() {
    try {
      setIsDownloading(true);
      setStatusMessage(undefined);
      setErrorMessage(undefined);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Image request failed with status ${response.status}`);
      }

      const blob = await response.blob();
      const extensionByMimeType: Record<string, string> = {
        "image/gif": "gif",
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      };
      const extension = extensionByMimeType[blob.type] ?? "jpg";
      const result = await saveImageBlob(blob, `maya-collage.${extension}`);

      setStatusMessage(
        result === "shared"
          ? "Collage shared."
          : result === "downloaded"
            ? "Download started."
            : "Download cancelled.",
      );
    } catch (error) {
      console.error("Failed to download image:", error);
      setErrorMessage("The collage could not be downloaded. Please try again.");
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="grid gap-1">
      <Button
        variant="outline"
        onClick={handleDownload}
        disabled={isDownloading}
        {...props}
      >
        Download
        {isDownloading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
      </Button>
      {statusMessage && (
        <p className="text-xs text-emerald-700" role="status">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p className="text-xs text-red-700" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

export default DownloadUrlButton;
