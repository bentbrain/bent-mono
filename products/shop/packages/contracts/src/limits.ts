// Cloudflare Images accepts 20 MB per input, in decimal bytes.
export const MAX_DESIGN_SOURCE_BYTES = 20_000_000;
export const MAX_DESIGN_SOURCE_EDGE = 12_000;
export const MAX_DESIGN_SOURCE_PIXELS = 50_000_000;
export const DESIGN_SOURCE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"];
// Leave room for the transparent base and small recursion layers in a print graph.
export const MAX_PREPARED_ARTWORK_BYTES = 19_000_000;
export const MAX_DESIGN_ARTWORK_BYTES = 20 * 1_024 * 1_024;
// Printify's PNG/JPEG print-file limit, independent of source uploads.
export const MAX_PRINT_ASSET_BYTES = 100_000_000;
export const MAX_INLINE_ARTWORK_PREVIEW_BYTES = 1_024 * 1_024;
