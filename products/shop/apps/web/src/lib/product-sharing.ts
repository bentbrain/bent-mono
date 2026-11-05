export interface WebShareTarget {
  canShare?: Navigator["canShare"];
  share?: Navigator["share"];
}

export type ShareResult = "shared" | "cancelled" | "fallback";

export function canShareProductFile(target: WebShareTarget, file: File) {
  const canShare = target.canShare;
  if (typeof target.share !== "function" || typeof canShare !== "function") {
    return false;
  }

  try {
    return canShare.call(target, { files: [file] });
  } catch {
    return false;
  }
}

export async function shareProductFile(
  target: WebShareTarget,
  file: File,
): Promise<ShareResult> {
  const share = target.share;
  if (typeof share !== "function" || !canShareProductFile(target, file)) {
    return "fallback";
  }

  try {
    await share.call(target, { files: [file] });
    return "shared";
  } catch (error) {
    return error instanceof Error && error.name === "AbortError"
      ? "cancelled"
      : "fallback";
  }
}
