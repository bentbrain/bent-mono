export interface ProductMockupGeometry {
  readonly canvas: {
    readonly dpi: 300;
    readonly heightPx: number;
    readonly widthPx: number;
  };
  readonly mockup: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
  };
}

export const PRODUCT_MOCKUP_GEOMETRY_VERSION: "physical-print-area-v1";

export const PRODUCT_MOCKUP_GEOMETRY: Readonly<{
  "cotton-tote": ProductMockupGeometry;
  "staple-tee": ProductMockupGeometry;
}>;
