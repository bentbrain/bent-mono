import { describe, expect, it } from "vitest";
import { configuredProductImagePath, productImageSrcSet, productImageWidth } from "./product-image";

describe("bounded product preview widths", () => {
  it("includes a phone candidate without changing revocable identity or the full preview", () => {
    const path = configuredProductImagePath({ color: "White", productId: "product-id" });
    expect(productImageWidth("960")).toBe(960);
    expect(productImageWidth(null)).toBe(1500);
    expect(productImageSrcSet(path)).toContain(`${path}&width=960 960w`);
    expect(path).toContain("access=revocable-v1");
    expect(productImageSrcSet(path, [192, 384])).not.toContain("960");
  });
  it("rejects arbitrary and oversized transformation widths", () => {
    for (const value of ["828", "961", "0", "-1", "1501", "999999", "NaN"]) {
      expect(productImageWidth(value)).toBeUndefined();
    }
  });
});
