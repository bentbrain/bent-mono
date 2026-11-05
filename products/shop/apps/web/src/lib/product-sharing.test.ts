import { describe, expect, it, vi } from "vitest";

import {
  canShareProductFile,
  shareProductFile,
  type WebShareTarget,
} from "@/lib/product-sharing";

const file = new File(["image"], "story.png", { type: "image/png" });
describe("product sharing", () => {
  it("checks file support before opening the native share sheet", async () => {
    const canShare = vi.fn(() => true);
    const share = vi.fn(() => Promise.resolve());
    const target: WebShareTarget = { canShare, share };

    await expect(shareProductFile(target, file)).resolves.toBe("shared");
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(share).toHaveBeenCalledWith({ files: [file] });
  });

  it("uses the fallback without calling share when files are unsupported", async () => {
    const share = vi.fn(() => Promise.resolve());
    const target: WebShareTarget = {
      canShare: vi.fn(() => false),
      share,
    };

    await expect(shareProductFile(target, file)).resolves.toBe("fallback");
    expect(share).not.toHaveBeenCalled();
  });

  it("treats canShare errors as unsupported file sharing", () => {
    const target: WebShareTarget = {
      canShare: vi.fn(() => {
        throw new Error("Unsupported share data");
      }),
      share: vi.fn(() => Promise.resolve()),
    };

    expect(canShareProductFile(target, file)).toBe(false);
  });

  it("does not show a fallback after the user cancels sharing", async () => {
    const cancelled = new Error("Share cancelled");
    cancelled.name = "AbortError";
    const target: WebShareTarget = {
      canShare: vi.fn(() => true),
      share: vi.fn(() => Promise.reject(cancelled)),
    };

    await expect(shareProductFile(target, file)).resolves.toBe("cancelled");
  });
});
