import { describe, expect, it } from "vitest";

import {
  SOCIAL_CARD_SETTINGS,
  createSocialCardMetadata,
  featuredSocialCardPath,
  productSocialCardPath,
  requestedSocialCardColor,
  resolveSocialCardColor,
  socialCardLayout,
} from "@/lib/social-card";

describe("social cards", () => {
  it("uses the approved 60px frame as layout padding", () => {
    const layout = socialCardLayout(SOCIAL_CARD_SETTINGS);

    expect(SOCIAL_CARD_SETTINGS.borderWidth).toBe(60);
    expect(layout.innerHeight).toBe(510);
    expect(layout.innerWidth).toBe(1_080);
    expect(layout.textX).toBe(112);
    expect(layout.productX).toBe(644);
    expect(layout.productPanelX).toBe(620);
    expect(layout.productPanelWidth).toBe(520);
    expect(layout.productY).toBe(67);
    expect(layout.renderedProductScale).toBe(496);
  });

  it("keeps the product identity and selected colour in versioned image URLs", () => {
    expect(productSocialCardPath("product/id", "Jet Black")).toBe(
      "/api/social-card/v4/product/product%2Fid/jet%20black.png",
    );
    expect(featuredSocialCardPath("cotton-tote", "Cream")).toBe(
      "/api/social-card/v4/featured/cotton-tote/cream.png",
    );
  });

  it("reads colour variants from canonical and landing page queries", () => {
    expect(requestedSocialCardColor({ Color: "White" }, "Color")).toBe(
      "White",
    );
    expect(
      requestedSocialCardColor({ shirtColor: ["Black", "White"] }, "shirtColor"),
    ).toBe("Black");
    expect(requestedSocialCardColor({ Color: "../invalid" }, "Color")).toBe(
      "Black",
    );
    expect(resolveSocialCardColor("staple-tee", "white")).toBe("White");
    expect(resolveSocialCardColor("cotton-tote", "invalid")).toBe("Black");
  });

  it("publishes large-image metadata for Open Graph and Twitter", () => {
    const metadata = createSocialCardMetadata({
      alt: "Black T-shirt with a bent.shop design",
      canonicalPath: "/product/product-1",
      documentTitle: "Custom T-shirt | bent.shop",
      imagePath: "/api/social-card/v4/product/product-1/black.png",
      sharePath: "/product/product-1?Color=Black",
    });

    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({ height: 630, width: 1_200 }),
    ]);
    expect(metadata.openGraph?.url).toBe("/product/product-1?Color=Black");
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });
});
