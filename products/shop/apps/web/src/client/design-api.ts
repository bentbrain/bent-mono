import type { EditorSettingsDto } from "@forever-tee/contracts";

import { artworkPreviewUrl } from "@/lib/artwork-preview";

export async function createDesign(challengeToken: string, signal?: AbortSignal) {
  const client = await import("@/client/effect-design-api");
  return client.createDesign(challengeToken, signal);
}

export async function processDesignArtwork(id: string, image: Blob, challengeToken?: string) {
  const client = await import("@/client/effect-design-api");
  return client.processDesignArtwork(id, image, challengeToken);
}

export async function updateDesignSettings(
  id: string,
  settings: EditorSettingsDto,
) {
  const client = await import("@/client/effect-design-api");
  return client.updateDesignSettings(id, settings);
}

export async function getDesign(id: string) {
  const client = await import("@/client/effect-design-api");
  return client.getDesign(id);
}

export async function getSavedDesigns(cursor: string | null, signal?: AbortSignal) {
  const client = await import("@/client/effect-design-api");
  return client.getSavedDesigns(cursor, signal);
}

export async function deleteDesign(id: string) {
  const client = await import("@/client/effect-design-api");
  return client.deleteDesign(id);
}

export async function getArtworkPreview(id: string, revision?: string) {
  const response = await fetch(artworkPreviewUrl(id, revision), { cache: "no-store" });
  if (!response.ok) {
    throw new Error("The artwork preview is unavailable.");
  }
  return response.blob();
}

export async function getArtworkSourcePreview(id: string, kind: "original" | "cutout") {
  const response = await fetch(`/api/design-drafts/${encodeURIComponent(id)}/artwork-sources/${kind}`, { cache: "no-store" });
  if (!response.ok) throw new Error("The photo could not be loaded. Please try again.");
  return response.blob();
}

export async function retryArtworkPreparation(id: string, artworkJobId: string) {
  const client = await import("@/client/effect-design-api");
  return client.retryArtworkPreparation(id, artworkJobId);
}
