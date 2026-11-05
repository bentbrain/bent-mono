export interface ImageRecipe {
  baseProductSlug: "staple-tee" | "cotton-tote";
  color: "White" | "Black" | "Cream";
  view: "flat" | "lifestyle";
  printMode: "recursive" | "base-image-only";
  storageKey: string;
  settings: {
    cropX: number;
    cropY: number;
    cropZoom: number;
    depth: number;
    placementX: number;
    placementY: number;
    placementWidth: number;
  };
}
export function parseImageRecipe(value: unknown): ImageRecipe;
export function renderProductDisplay(
  artwork: Uint8Array,
  recipe: ImageRecipe,
  assetDirectory: string,
): Promise<Uint8Array>;
export const RENDERER_VERSION: "product-images-v5";
