import { createHash } from "node:crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGINS = {
    production: "https://forever-tee-api.socialqueue.workers.dev",
    development: "https://forever-tee-api-development.socialqueue.workers.dev",
};
const MOCKUPS = {
    "staple-tee": { black: "tee-black-cutout-v1.png", white: "tee-white-cutout-v1.png" },
    "cotton-tote": { black: "tote-black-print-bar-1001.webp", cream: "tote-cream-print-bar-1001.webp" },
};
const check = (condition, message) => { if (!condition)
    throw new Error(message); };
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function featuredSelection(value) {
    check(Array.isArray(value) && value.length >= 1 && value.length <= 6, "Expected one to six current featured products.");
    const slots = new Set(), ids = new Set();
    for (const product of value) {
        check(product && Number.isInteger(product.slot) && product.slot >= 1 && product.slot <= 6 &&
            typeof product.productId === "string" && UUID.test(product.productId) &&
            !slots.has(product.slot) && !ids.has(product.productId), "Invalid or duplicate featured product.");
        slots.add(product.slot);
        ids.add(product.productId);
    }
    return value.map(({ slot, productId }) => ({ slot, productId })).sort((a, b) => a.slot - b.slot);
}
export function selectFinalProduct(products, input) {
    const selection = input?.trim().toLowerCase() || "1";
    if (/^[1-6]$/.test(selection)) {
        const product = products.find(product => product.slot === Number(selection));
        check(product, `Featured slot ${selection} is not currently available.`);
        return product.productId;
    }
    check(UUID.test(selection), "Final product must be a featured slot 1–6 or a configured product UUID.");
    return selection;
}
function validateSnapshot(value, productId) {
    check(value && value.configuredProductId === productId &&
        typeof value.designId === "string" && UUID.test(value.designId) &&
        typeof value.designRevisionId === "string" && UUID.test(value.designRevisionId) &&
        Object.hasOwn(MOCKUPS, value.baseProductSlug) &&
        typeof value.artworkSha256 === "string" && /^[0-9a-f]{64}$/.test(value.artworkSha256) &&
        ["image/png", "image/jpeg", "image/webp"].includes(value.contentType) &&
        Number.isSafeInteger(value.byteSize) && value.byteSize > 0 && value.byteSize <= 25000000, "Invalid configured product snapshot or artwork metadata.");
    const p = value.placement;
    check(p && [p.x, p.y, p.width].every(Number.isFinite) && p.x >= 0 && p.y >= 0 &&
        p.width >= 0.08 && p.width <= 0.48 && p.x + p.width <= 1 && p.y + p.width <= 1 &&
        Number.isInteger(p.depth) && p.depth >= 1 && p.depth <= 8, "Invalid product placement.");
    check(value.artworkUrl === `/v2/internal/design-revisions/${value.designRevisionId}/artwork`, "Artwork must use the immutable revision endpoint.");
    return value;
}
async function boundedBody(response, limit) {
    check(response.ok && response.body, `Product API request failed with HTTP ${response.status}.`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.byteLength;
        check(size <= limit, "Product API response exceeded its size limit.");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
export async function loadFeaturedRenderInputs(env, request = fetch) {
    const origin = ORIGINS[env.RENDER_ENVIRONMENT];
    check(origin && env.WORKER_URL === origin, "WORKER_URL must match the selected environment's API.");
    check(env.FOREVER_TEE_API_SHARED_SECRET, "FOREVER_TEE_API_SHARED_SECRET is missing.");
    const get = async (path, limit = 100000) => boundedBody(await request(new URL(path, origin), {
        method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60000),
        headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET },
    }), limit);
    const json = async (path) => JSON.parse((await get(path)).toString("utf8"));
    const readSelection = async () => featuredSelection((await json("/v2/internal/featured-products")).products);
    const featured = await readSelection();
    const finalProductId = selectFinalProduct(featured, env.FINAL_PRODUCT);
    const finalSnapshot = validateSnapshot(await json(`/v2/internal/configured-products/${finalProductId}`), finalProductId);
    const color = env.RENDER_COLOR && env.RENDER_COLOR !== "default" ? env.RENDER_COLOR :
        finalSnapshot.baseProductSlug === "cotton-tote" ? "black" : "white";
    const colors = MOCKUPS[finalSnapshot.baseProductSlug];
    const mockupFile = Object.hasOwn(colors, color) ? colors[color] : undefined;
    check(mockupFile, `Color ${color} is unavailable for ${finalSnapshot.baseProductSlug}.`);
    // Deepest first in the reveal: current slot order, then the chosen final design.
    // A sibling configured product for the same design must not duplicate that cutout.
    const otherIds = featured.map(product => product.productId).filter(id => id !== finalProductId);
    const snapshots = await Promise.all(otherIds.map(async (id) => validateSnapshot(await json(`/v2/internal/configured-products/${id}`), id)));
    const others = snapshots.filter(snapshot => snapshot.designId !== finalSnapshot.designId);
    check(new Set(others.map(snapshot => snapshot.designId)).size === others.length, "Featured slots contain duplicate designs.");
    const outerToInner = [finalSnapshot, ...others.reverse()];
    const layers = await Promise.all(outerToInner.map(async (snapshot) => {
        const design = await json(`/v1/designs/${snapshot.designId}`);
        check(design?.id === snapshot.designId && design.status === "ready" &&
            design.artworkRevision === snapshot.artworkSha256, "Design changed since its product revision was saved.");
        const crop = design.settings;
        check(crop && [crop.cropX, crop.cropY, crop.cropZoom].every(Number.isFinite) &&
            crop.cropX >= 0 && crop.cropX <= 1 && crop.cropY >= 0 && crop.cropY <= 1 &&
            crop.cropZoom >= 0.65 && crop.cropZoom <= 2.6, "Invalid design crop.");
        const artwork = await get(snapshot.artworkUrl, snapshot.byteSize);
        check(artwork.length === snapshot.byteSize && sha256(artwork) === snapshot.artworkSha256, "Artwork size or SHA-256 does not match the product revision.");
        return { productId: snapshot.configuredProductId, designId: snapshot.designId,
            revisionId: snapshot.designRevisionId, artworkSha256: snapshot.artworkSha256,
            crop: { cropX: crop.cropX, cropY: crop.cropY, cropZoom: crop.cropZoom },
            placement: snapshot.placement, artwork };
    }));
    check(JSON.stringify(featured) === JSON.stringify(await readSelection()), "Featured selection changed during preparation. Run again for the current selection.");
    return { featured, finalProductId, color, baseProductSlug: finalSnapshot.baseProductSlug, mockupFile, layers };
}
