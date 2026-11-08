import { afterEach, expect, it, vi } from "vitest";
import { getArtworkPreview, getArtworkSourcePreview } from "./design-api";

afterEach(() => vi.unstubAllGlobals());

it("loads ordinary owner previews through the session BFF, including finalized legacy designs", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/webp" } }));
  vi.stubGlobal("fetch", fetcher);
  expect((await getArtworkPreview("design-id", "a".repeat(64))).size).toBe(2);
  expect(fetcher).toHaveBeenCalledWith(`/api/design-drafts/design-id/artwork/preview?revision=${"a".repeat(64)}`, { cache: "no-store" });
});

it("keeps the editable source preview on its separate endpoint and propagates denial", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(getArtworkSourcePreview("design-id", "cutout")).rejects.toThrow("The photo could not be loaded");
  expect(fetcher).toHaveBeenCalledWith("/api/design-drafts/design-id/artwork-sources/cutout", { cache: "no-store" });
  await expect(getArtworkPreview("design-id")).rejects.toThrow("The artwork preview is unavailable");
});
