import type { CSSProperties } from "react";

import {
  productMockupArtworkLayout,
  type BaseProductSlug,
} from "@forever-tee/contracts/product-projection";

export function productProjectionArtworkStyle(
  slug: BaseProductSlug,
): CSSProperties {
  const layout = productMockupArtworkLayout(slug);
  return {
    aspectRatio: `${String(layout.width)} / ${String(layout.height)}`,
    left: `${String(layout.left * 100)}%`,
    top: `${String(layout.top * 100)}%`,
    width: `${String(layout.width * 100)}%`,
  };
}

export function productProjectionMockupPath(
  slug: BaseProductSlug,
  color: string,
) {
  if (slug === "staple-tee") {
    return color.toLowerCase() === "white"
      ? "/mockups/tee-white-v1.png"
      : "/mockups/tee-black-v1.png";
  }
  return color.toLowerCase() === "cream"
    ? "/mockups/tote-cream-print-bar-1001.webp"
    : "/mockups/tote-black-print-bar-1001.webp";
}
