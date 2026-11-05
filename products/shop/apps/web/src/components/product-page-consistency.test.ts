import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("product page routes", () => {
  it("routes the featured and product pages through the shared component", async () => {
    const [
      configuredProductFamily,
      defaultProductFamily,
      featuredPage,
      productPageContent,
      productPage,
      shirtEditor,
      select,
    ] = await Promise.all([
      readFile(
        new URL("./configured-product-family.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("./default-product-family.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/featured/[slug]/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("./product-page-content.tsx", import.meta.url), "utf8"),
      readFile(
        new URL("../app/product/[id]/page.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("./shirt-editor.tsx", import.meta.url), "utf8"),
      readFile(new URL("./ui/select.tsx", import.meta.url), "utf8"),
    ]);

    expect(featuredPage).toContain("return ProductPageData(");
    expect(featuredPage).toContain("SAMPLE_PRODUCT_ID");
    expect(featuredPage).not.toContain("syncUrl={false}");
    expect(featuredPage).toContain("syncUrl: true");
    expect(featuredPage).toContain("syncVariantUrl");
    expect(featuredPage).toContain('variantPathname: featuredProductPath(featured.productId)');
    expect(featuredPage).toContain('familyQueryParamName: "product"');
    expect(configuredProductFamily).toContain("familyQueryParamName");
    expect(defaultProductFamily).toContain("familyQueryParamName");
    expect(select).toContain('data-[size=lg]:h-11');
    expect(productPage).toContain("<ProductPageContent");
    expect(configuredProductFamily).toContain("<ProductFamily");
    expect(configuredProductFamily).toContain("<ProductConfigurator");
    expect(configuredProductFamily).not.toContain("ShirtEditor");
    expect(defaultProductFamily).toContain("<ProductFamily");
    expect(productPageContent).not.toContain("ProductArtworkPreload");
    expect(productPageContent).not.toContain("ArtworkPreload");
    expect(productPageContent).not.toContain("getProductDesignRecord");
    expect(shirtEditor).not.toContain("ProductConfigurator");
    expect(featuredPage).not.toContain("ProductPresentation");
    expect(featuredPage).not.toContain("ConfiguredProductMockup");
    expect(featuredPage).not.toContain("ShirtEditor");
  });
});
