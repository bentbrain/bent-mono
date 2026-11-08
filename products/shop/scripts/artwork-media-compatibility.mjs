export const ARTWORK_MEDIA_CAPABILITY = "owner-artwork-media-v1";

// Existing immutable artifact and source review checks remain authoritative.
// Rollback may only select artifacts declaring the owner-media contract.
export function assertArtworkMediaBundle(bytes) {
  if (!new TextDecoder().decode(bytes).includes(JSON.stringify(ARTWORK_MEDIA_CAPABILITY))) {
    throw new Error("Worker rollback requires the owner artwork media capability.");
  }
}

export function assertArtworkMediaWeb(deployment) {
  if (deployment?.artworkMediaCapability !== ARTWORK_MEDIA_CAPABILITY) {
    throw new Error("Storefront rollback requires the owner artwork media capability.");
  }
}
