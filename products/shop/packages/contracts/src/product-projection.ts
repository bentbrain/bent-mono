import type { EditorSettingsDto } from "./design";
import { PRODUCT_MOCKUP_GEOMETRY } from "./product-mockup-geometry.js";
export const STAPLE_TEE_BASE_PRODUCT_ID = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
export const COTTON_TOTE_BASE_PRODUCT_ID = "97b629d7-1d3b-4d2a-a586-537168141e97";
export type BaseProductSlug = "staple-tee" | "cotton-tote";
export type ProductProjectionVersion = "legacy-shirt-v1" | "safe-margin-v1";
export interface ProductPlacement {
    readonly depth: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
}
export interface ProductProjectionSpecification {
    readonly canvas: {
        readonly dpi: 300;
        readonly heightPx: number;
        readonly widthPx: number;
    };
    readonly colors: readonly string[];
    readonly defaultColor: string;
    readonly name: string;
    readonly safeMarginPx: number;
    readonly sizes: readonly string[];
    readonly slug: BaseProductSlug;
    readonly version: "safe-margin-v1";
}
export interface ProductMockupArtworkLayout {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
}
const PRODUCT_PROJECTION_SPECIFICATIONS: Record<BaseProductSlug, ProductProjectionSpecification> = {
    "staple-tee": {
        // Printify blueprint 440/provider 34. The 118 px inset is 10 mm at 300 DPI.
        canvas: PRODUCT_MOCKUP_GEOMETRY["staple-tee"].canvas,
        colors: ["Black", "White"],
        defaultColor: "White",
        name: "AS Colour Staple Tee 5001",
        safeMarginPx: 118,
        sizes: ["S", "M", "L", "XL", "2XL", "3XL"],
        slug: "staple-tee",
        version: "safe-margin-v1",
    },
    "cotton-tote": {
        // Printify blueprint 553/provider 34. The 118 px inset is 10 mm at 300 DPI.
        canvas: PRODUCT_MOCKUP_GEOMETRY["cotton-tote"].canvas,
        colors: ["Black", "Cream"],
        defaultColor: "Black",
        name: "AS Colour Cotton Tote 1001",
        safeMarginPx: 118,
        sizes: ["One size"],
        slug: "cotton-tote",
        version: "safe-margin-v1",
    },
};
export function productProjectionSpecification(slug: BaseProductSlug): ProductProjectionSpecification {
    return PRODUCT_PROJECTION_SPECIFICATIONS[slug];
}
export function productMockupArtworkLayout(slug: BaseProductSlug): ProductMockupArtworkLayout {
    const geometry = PRODUCT_MOCKUP_GEOMETRY[slug];
    return {
        height: geometry.mockup.width *
            (geometry.canvas.heightPx / geometry.canvas.widthPx),
        left: geometry.mockup.left,
        top: geometry.mockup.top,
        width: geometry.mockup.width,
    };
}
export function baseProductSlugForId(id: string): BaseProductSlug | undefined {
    if (id === STAPLE_TEE_BASE_PRODUCT_ID)
        return "staple-tee";
    if (id === COTTON_TOTE_BASE_PRODUCT_ID)
        return "cotton-tote";
    return undefined;
}
function stableProjectionNumber(value: number) {
    return Math.round(value * 1000000) / 1000000;
}
export function projectEditorPlacement(settings: Pick<EditorSettingsDto, "depth" | "placementWidth" | "placementX" | "placementY">, slug: BaseProductSlug): ProductPlacement {
    const specification = productProjectionSpecification(slug);
    const safeWidth = (specification.canvas.widthPx - 2 * specification.safeMarginPx) /
        specification.canvas.widthPx;
    const safeHeight = (specification.canvas.heightPx - 2 * specification.safeMarginPx) /
        specification.canvas.heightPx;
    const scale = Math.min(safeWidth, safeHeight);
    const inset = (1 - scale) / 2;
    return {
        depth: settings.depth,
        width: stableProjectionNumber(settings.placementWidth * scale),
        x: stableProjectionNumber(inset + settings.placementX * scale),
        y: stableProjectionNumber(inset + settings.placementY * scale),
    };
}
