export type ImageSaveResult = "cancelled" | "downloaded" | "shared";

export function dataUrlToBlob(dataUrl: string): Blob {
  const [metadata, encodedData] = dataUrl.split(",");
  const mimeType = metadata?.match(/^data:(.*?);base64$/)?.[1];

  if (!encodedData || !mimeType) {
    throw new Error("The collage image could not be generated.");
  }

  const decodedData = atob(encodedData);
  const bytes = new Uint8Array(decodedData.length);

  for (let index = 0; index < decodedData.length; index += 1) {
    bytes[index] = decodedData.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  // WebKit can cancel a download when its object URL is revoked immediately.
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

export async function saveImageBlob(
  blob: Blob,
  fileName: string,
): Promise<ImageSaveResult> {
  const file = new File([blob], fileName, { type: blob.type });
  const shareData: ShareData = {
    files: [file],
    title: "Maya's Collage",
  };
  const hasCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const canShareFile =
    hasCoarsePointer &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare(shareData);

  if (canShareFile) {
    try {
      await navigator.share(shareData);
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
      }
      // Some mobile browsers report support but lose user activation while an
      // image is prepared. Fall through to the regular Blob download.
    }
  }

  triggerBrowserDownload(blob, fileName);
  return "downloaded";
}
