import { describe, expect, it } from "vitest";

import { PRODUCT_QUERY } from "@/lib/product-query";
import { requiresExplicitSizeSelection } from "@/lib/product-selection";

describe("PRODUCT_QUERY", () => {
  it("loads the full variant matrix for immediate cross-option selection", () => {
    expect(PRODUCT_QUERY).toContain("variants(first: 100)");
    expect(PRODUCT_QUERY).not.toContain("adjacentVariants(");
  });

  it("requires an explicit choice when a product has multiple sizes", () => {
    const options = [
      { name: "Color", optionValues: ["Black", "White"] },
      { name: "Size", optionValues: ["S", "M", "L"] },
    ];

    expect(requiresExplicitSizeSelection(options, [])).toBe(true);
    expect(requiresExplicitSizeSelection(options, [
      { name: "Color", value: "Black" },
    ])).toBe(true);
    expect(requiresExplicitSizeSelection(options, [
      { name: "Size", value: "M" },
    ])).toBe(false);
  });

  it("does not ask for a redundant one-size selection", () => {
    expect(requiresExplicitSizeSelection([
      { name: "Size", optionValues: ["One size"] },
    ], [])).toBe(false);
  });
});
