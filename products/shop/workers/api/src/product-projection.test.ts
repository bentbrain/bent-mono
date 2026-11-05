import { describe, expect, it } from "vitest";

import {
  productProjectionSpecification,
  projectEditorPlacement,
  type BaseProductSlug,
} from "@forever-tee/contracts";

const settings = {
  depth: 5,
  placementWidth: 0.22,
  placementX: 0.39,
  placementY: 0.43,
};

describe("launch product projections", () => {
  it("pins the authenticated launch canvas geometry", () => {
    expect(productProjectionSpecification("staple-tee")).toMatchObject({
      canvas: { dpi: 300, heightPx: 5_846, widthPx: 4_665 },
      colors: ["Black", "White"],
      version: "safe-margin-v1",
    });
    expect(productProjectionSpecification("cotton-tote")).toMatchObject({
      canvas: { dpi: 300, heightPx: 3_425, widthPx: 2_835 },
      colors: ["Black", "Cream"],
      sizes: ["One size"],
      version: "safe-margin-v1",
    });
  });

  it("generates distinct deterministic placements inside each safe margin", () => {
    const shirt = projectEditorPlacement(settings, "staple-tee");
    const tote = projectEditorPlacement(settings, "cotton-tote");
    expect(shirt).not.toEqual(tote);
    expect(projectEditorPlacement(settings, "staple-tee")).toEqual(shirt);
    expect(projectEditorPlacement(settings, "cotton-tote")).toEqual(tote);

    const slugs: readonly BaseProductSlug[] = ["staple-tee", "cotton-tote"];
    for (const slug of slugs) {
      const specification = productProjectionSpecification(slug);
      const placement = projectEditorPlacement(settings, slug);
      const horizontalMargin =
        specification.safeMarginPx / specification.canvas.widthPx;
      const verticalMargin =
        specification.safeMarginPx / specification.canvas.heightPx;
      expect(placement.x).toBeGreaterThanOrEqual(horizontalMargin);
      expect(placement.y).toBeGreaterThanOrEqual(verticalMargin);
      expect(placement.x + placement.width)
        .toBeLessThanOrEqual(1 - horizontalMargin);
      expect(placement.y + placement.width)
        .toBeLessThanOrEqual(1 - verticalMargin);
    }
  });


});
