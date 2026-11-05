import { describe, expect, it } from "vitest";

import {
  canonicalProductSelectionParams,
  familyProductUrl,
  landingProductOptionPrefix,
  landingProductQuery,
  loadLandingProductParams,
  productQueryWithDefaultColor,
  productVariantUrl,
} from "@/lib/product-params";

describe("landing product parameters", () => {
  it("keeps shirt and tote variants independent in a shared URL", () => {
    const query = {
      product: "tote",
      shirtColor: "White",
      shirtSize: "M",
      toteColor: "White",
    };

    expect(landingProductOptionPrefix("staple-tee")).toBe("shirt");
    expect(landingProductOptionPrefix("cotton-tote")).toBe("tote");
    const params = loadLandingProductParams(query);

    expect(landingProductQuery(params, "staple-tee", query)).toEqual({
      Color: "White",
      Size: "M",
    });
    expect(landingProductQuery(params, "cotton-tote", query)).toEqual({
      Color: "White",
    });
  });

  it("accepts legacy active-product params without applying them to its sibling", () => {
    const query = { Color: "Cream", product: "tote" };
    const params = loadLandingProductParams(query);

    expect(landingProductQuery(params, "cotton-tote", query)).toEqual({
      Color: "Cream",
    });
    expect(landingProductQuery(params, "staple-tee", query)).toEqual({});
  });
});

describe("shared product parameter URLs", () => {
  it("uses the analysed colour only when the URL has no explicit colour", () => {
    expect(productQueryWithDefaultColor({ Size: "M" }, "Black")).toEqual({
      Color: "Black",
      Size: "M",
    });
    expect(productQueryWithDefaultColor({ Color: "White" }, "Black"))
      .toEqual({ Color: "White" });
  });

  it("maps canonical option selections to the typed nuqs keys", () => {
    expect(canonicalProductSelectionParams([
      { name: "Size", value: "M" },
      { name: "Color", value: "Cream" },
    ])).toEqual({ Color: "Cream", Size: "M" });
  });

  it("maps a light design default to the product's real colour without overriding a choice", () => {
    expect(productQueryWithDefaultColor({}, "White", "cotton-tote"))
      .toEqual({ Color: "Cream", Size: "One size" });
    expect(productQueryWithDefaultColor({}, "White", "staple-tee"))
      .toEqual({ Color: "White" });
    expect(productQueryWithDefaultColor({}, "Black", "cotton-tote"))
      .toEqual({ Color: "Black", Size: "One size" });
    expect(productQueryWithDefaultColor({ Color: "Black" }, "White", "cotton-tote"))
      .toEqual({ Color: "Black", Size: "One size" });
    expect(productQueryWithDefaultColor({ Color: "Cream" }, "Black", "cotton-tote"))
      .toEqual({ Color: "Cream", Size: "One size" });
    expect(productQueryWithDefaultColor({ Color: "Cream", Size: "One size" }, "Black", "cotton-tote"))
      .toEqual({ Color: "Cream", Size: "One size" });
  });

  it("builds variant and family URLs without dropping unrelated parameters", () => {
    const variantUrl = productVariantUrl(
      "/product/tote",
      [{ name: "Color" }, { name: "Size" }],
      [
        { name: "Color", value: "Cream" },
        { name: "Size", value: "One size" },
      ],
      new URLSearchParams("designRevision=revision&Color=Black"),
    );

    expect(variantUrl).toBe(
      "/product/tote?designRevision=revision&Color=Cream&Size=One+size",
    );
    expect(familyProductUrl(variantUrl, "product", "cotton-tote")).toBe(
      "/product/tote?designRevision=revision&Color=Cream&Size=One+size&product=tote",
    );
  });
});
