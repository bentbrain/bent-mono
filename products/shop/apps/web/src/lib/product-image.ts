import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { PRODUCT_MOCKUP_GEOMETRY_VERSION } from "@forever-tee/contracts/product-mockup-geometry";

const PRODUCT_IMAGE_WIDTHS = [192, 384, 768, 960, 1200, 1500];

export function productImageWidth(value: string | null) {
  if (value === null) return 1500;
  const width = Number(value);
  return PRODUCT_IMAGE_WIDTHS.includes(width) ? width : undefined;
}

export function sizedProductImagePath(path: string, width: number) {
  return `${path}&width=${String(width)}`;
}

export function productImageSrcSet(path: string, widths = PRODUCT_IMAGE_WIDTHS) {
  return widths.map(width => `${sizedProductImagePath(path, width)} ${String(width)}w`).join(", ");
}

function geometryVersionQuery() {
  // Use new URLs to avoid the former year-long immutable browser/CDN entries.
  return `?geometry=${encodeURIComponent(PRODUCT_MOCKUP_GEOMETRY_VERSION)}&access=revocable-v1`;
}

export function configuredProductImagePath({
  color,
  productId,
}: {
  color: string;
  productId: string;
}) {
  return `/api/configured-product-image/current/${encodeURIComponent(productId)}/${encodeURIComponent(color.toLowerCase())}.webp${geometryVersionQuery()}`;
}

export function cartProductImagePath(product: { color: string; productId: string }) {
  return sizedProductImagePath(configuredProductImagePath(product), 384);
}

export function productImagePath({
  baseProductSlug,
  color,
  designId,
  productId,
  revision,
}: {
  color: string;
  baseProductSlug: BaseProductSlug;
  designId: string;
  productId?: string;
  revision: string;
}) {
  const productColor = color.toLowerCase();
  if (productId) {
    return configuredProductImagePath({ color, productId });
  }
  const garmentColor = productColor === "white" ? "white" : "black";
  if (baseProductSlug === "cotton-tote") {
    throw new Error("A configured product id is required for tote images.");
  }
  return `/api/product-image/${encodeURIComponent(designId)}/${encodeURIComponent(revision)}/${garmentColor}.webp${geometryVersionQuery()}`;
}
