import { describe, expect, it } from "vitest";

import type { FeaturedProduct } from "@/config/featured-products";
import { featuredProductPath, legacyFeaturedProductPath } from "./featured-products";

const products: readonly FeaturedProduct[] = [
  { slot: 1, productId: "original" },
  { slot: 3, productId: "portrait" },
  { slot: 6, productId: "illustration" },
];

describe("featured product routes", () => {
  it("uses product identity regardless of slot order", () => {
    expect(legacyFeaturedProductPath(products.toReversed(), { featured: "3" })).toBe(featuredProductPath("portrait"));
  });
  it("keeps unnumbered visits and invalid slots on the grid", () => {
    expect(legacyFeaturedProductPath(products, {})).toBeUndefined();
    expect(legacyFeaturedProductPath(products, { utm_source: "share" })).toBeUndefined();
    expect(legacyFeaturedProductPath(products, { featured: "2" })).toBeUndefined();
  });
  it("preserves selected options and repeated query values from old product links", () => {
    expect(legacyFeaturedProductPath(products, { product: "tote", toteColor: "Black", tag: ["one", "two"] }))
      .toBe("/featured/original?product=tote&toteColor=Black&tag=one&tag=two");
    expect(legacyFeaturedProductPath(products, { shirtColor: "White", shirtSize: "M" }))
      .toBe("/featured/original?shirtColor=White&shirtSize=M");
    expect(legacyFeaturedProductPath(products, { featured: ["3", "6"], Color: "White" }))
      .toBe("/featured/portrait?Color=White");
  });
});
