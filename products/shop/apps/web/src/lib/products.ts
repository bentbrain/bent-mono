import { COTTON_TOTE_BASE_PRODUCT_ID, STAPLE_TEE_BASE_PRODUCT_ID, type BaseProductSlug, } from "@forever-tee/contracts/product-projection";
export const BASE_PRODUCT_ID = STAPLE_TEE_BASE_PRODUCT_ID;
export const LAUNCH_BASE_PRODUCTS = [
    {
        id: STAPLE_TEE_BASE_PRODUCT_ID,
        shopifyHandle: "bent-shirt",
        slug: "staple-tee",
    },
    {
        id: COTTON_TOTE_BASE_PRODUCT_ID,
        shopifyHandle: "cotton-tote",
        slug: "cotton-tote",
    },
] satisfies readonly {
    id: string;
    shopifyHandle: string;
    slug: BaseProductSlug;
}[];
export const SAMPLE_PRODUCT_ID = "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4";
export function productPath(productId?: string) {
    if (!productId)
        return "/";
    return `/product/${encodeURIComponent(productId)}`;
}
export function createPath() {
    return "/create";
}
export function designPath(designId: string) {
    return `/design/${encodeURIComponent(designId)}`;
}
