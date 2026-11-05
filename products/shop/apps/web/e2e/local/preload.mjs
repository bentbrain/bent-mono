import "../../../../scripts/test-protected-config.mjs";
import { protectedConfig } from "../../../../scripts/protected-config.mjs";
// Test process only: real Next routes and components, deterministic upstreams.
// Never load production secrets or permit a fallback to live services.
import { MockAgent, setGlobalDispatcher } from "undici";
import { readFileSync } from "node:fs";
const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect(/^(localhost|127\.0\.0\.1):\d+$/);
setGlobalDispatcher(agent);
const headers = { "content-type": "application/json" };
// Production-mode verification exercises streaming against a slow optional
// upstream without slowing the ordinary browser gate.
const estimateDelay = process.env["E2E_LOCAL_PRODUCTION"] === "1" ? 2000 : 0;
const api = agent.get("https://api.example.com");
// Exercise the deployed product's Black default; allow the same checks to run
// against White without changing application configuration or live records.
const productDefaultColor = process.env["E2E_LOCAL_PRODUCT_DEFAULT_COLOR"] ?? "Black";
if (!["White", "Black"].includes(productDefaultColor))
    throw new Error("Invalid fixture product colour.");
api.intercept({ path: "/v2/internal/sales-intake" }).reply(200, { paused: true }, { headers }).persist();
api.intercept({ path: "/v2/design-drafts" }).reply(200, [], { headers }).persist();
api.intercept({ path: "/v2/design-drafts?page=1" }).reply(200, { items: [], nextCursor: null }, { headers }).persist();
const featuredFixtureIds = [
    protectedConfig("resource_60ac4424fdf7"),
    protectedConfig("resource_400df0568747"),
    "6b519f9c-a9de-4e9c-b989-1a961c4f1ab3", "0397e245-5c3d-4ae6-a793-5d4e733be153",
    "0010bd84-ea58-4d9e-99fd-553fdb09f215",
];
api.intercept({ path: "/v2/internal/featured-products" }).reply(200, {
    products: ["d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4", ...featuredFixtureIds].map((productId, index) => ({ slot: index + 1, productId })),
}, { headers }).persist();
for (const id of featuredFixtureIds) {
    const record = {
        id, baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
        designId: null, designRevisionId: null, placement: null, projectionVersion: null,
        defaultColor: "White", shopifyHandle: "bent-shirt", createdAt: "2026-09-05T00:00:00Z",
    };
    api.intercept({ path: `/v1/products/${id}` }).reply(200, record, { headers }).persist();
    api.intercept({ path: `/v1/products/${id}/family` }).reply(200, [record], { headers }).persist();
}
api.intercept({ path: "/v1/products/" + "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4" }).reply(200, {
    id: "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4",
    baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
    designId: null, designRevisionId: null, placement: null, projectionVersion: null,
    defaultColor: productDefaultColor, shopifyHandle: "bent-shirt", createdAt: "2026-09-05T00:00:00Z",
}, { headers }).persist();
api.intercept({ path: "/v1/products/" + "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4" + "/family" }).reply(200, [{
        id: "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4", baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
        designId: null, designRevisionId: null, placement: null, projectionVersion: null,
        defaultColor: productDefaultColor, shopifyHandle: "bent-shirt", createdAt: "2026-09-05T00:00:00Z",
    }], { headers }).persist();
const deliveryFixture = api.intercept({ path: /^\/v2\/internal\/catalogue\?/ }).reply(200, {
    variants: [{ standardShippingToAustralia: { handlingDaysFrom: 3, handlingDaysTo: 5 } }],
}, { headers }).persist();
if (estimateDelay > 0)
    deliveryFixture.delay(estimateDelay);
agent.get("https://printify.com").intercept({ path: "/wp-json/wp/v2/pages?slug=network-fulfillment-status" })
    .reply(200, [], { headers }).persist();
agent.get("https://ci.myshopify.com").intercept({ path: /^\/api\/.*\/graphql.json$/, method: "POST" }).reply(options => {
    const body = JSON.parse(String(options.body));
    if (body.query.startsWith("query redirects("))
        return { statusCode: 200, data: JSON.stringify({ data: { urlRedirects: { edges: [] } } }), responseOptions: { headers } };
    if (!body.query.includes("query ForeverTeeProduct"))
        throw Error("Unexpected local Storefront operation.");
    const { handle, selectedOptions } = body.variables;
    if (process.env["E2E_LOCAL_PRODUCTION"] === "1") {
        console.info("Local catalogue upstream read", JSON.stringify({ handle, selectedOptions }));
    }
    if (!["bent-shirt", "cotton-tote"].includes(handle))
        throw Error("Unexpected local product.");
    const tote = handle === "cotton-tote";
    const colors = tote ? ["Cream", "Black"] : ["White", "Black"];
    const sizes = tote ? ["One size"] : ["S", "M", "L"];
    const title = tote ? "Cotton Tote" : "bent.shop";
    const variants = colors.flatMap((color, c) => sizes.map((size, s) => ({
        id: `gid://shopify/ProductVariant/${tote ? 200 : 100}${c}${s}`, title: `${color} / ${size}`,
        availableForSale: true, selectedOptions: [{ name: "Color", value: color }, { name: "Size", value: size }],
        price: { amount: tote ? "30.00" : "40.00", currencyCode: "AUD" }, compareAtPrice: null,
        product: { handle, title }, sku: `${handle}-${c}-${s}`,
    })));
    const product = {
        id: `gid://shopify/Product/${tote ? 200 : 100}`, handle, title, vendor: "bent.shop", requiresSellingPlan: false,
        encodedVariantExistence: tote ? "v1_0:0,1:0" : "v1_0:0-2,1:0-2",
        encodedVariantAvailability: tote ? "v1_0:0,1:0" : "v1_0:0-2,1:0-2",
        options: [{ name: "Color", values: colors }, { name: "Size", values: sizes }].map(({ name, values }) => ({
            name, optionValues: values.map(value => ({ name: value, swatch: null,
                firstSelectableVariant: variants.find(variant => variant.selectedOptions.some(option => option.name === name && option.value === value)),
            })),
        })),
        selectedOrFirstAvailableVariant: variants.find(variant => selectedOptions.every(selected => variant.selectedOptions.some(option => option.name === selected.name && option.value === selected.value))) ?? variants[0],
        variants: { nodes: variants, pageInfo: { hasNextPage: false } }, priceRange: { minVariantPrice: variants[0].price },
    };
    return { statusCode: 200, data: JSON.stringify({ data: { product } }), responseOptions: { headers } };
}).persist();
api.intercept({ path: "/v2/internal/manage-order", method: "GET", headers: { "x-order-management-capability": "a".repeat(43) } }).reply(() => ({ statusCode: 200, data: JSON.stringify({ orderName: "#LOCAL-1001", deadline: new Date(Date.now() + 3600000).toISOString(), serverTime: new Date().toISOString(), totalMinorUnits: 7000, currencyCode: "AUD", address: { firstName: "Ada", lastName: "Lovelace", address1: "1 Queen Street", address2: "", city: "Brisbane", provinceCode: "QLD", zip: "4000", countryCode: "AU", phone: "" }, addressValidation: "no_issues" }), responseOptions: { headers } })).persist();
api.intercept({ path: "/v2/internal/manage-order", method: "GET" }).reply(410, { error: "ORDER_UNAVAILABLE" }, { headers }).persist();
api.intercept({ path: "/v2/internal/manage-order", method: "POST", headers: { "x-order-management-capability": "a".repeat(43) } }).reply(options => {
    const body = JSON.parse(String(options.body));
    if (body.operation === "cancel" && body.confirmation !== "CANCEL AND REFUND")
        throw Error("Cancellation needs confirmation");
    return { statusCode: body.operation === "cancel" ? 202 : 200, data: JSON.stringify({ commandId: body.commandId, status: body.operation === "cancel" ? "processing" : "succeeded" }), responseOptions: { headers } };
}).persist();
// Synthetic configured family exercises the real responsive compositor.
const performanceDesignId = "2c22bf7e-e698-4a0a-90c4-66c5549f1c45";
const performanceRevisionId = "3c22bf7e-e698-4a0a-90c4-66c5549f1c45";
api.intercept({ path: `/v2/design-drafts/${performanceDesignId}` }).reply(404, { error: "NOT_FOUND" }, { headers }).persist();
const performanceFamily = [
    { id: "4c22bf7e-e698-4a0a-90c4-66c5549f1c45", baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c", shopifyHandle: "bent-shirt" },
    { id: "5c22bf7e-e698-4a0a-90c4-66c5549f1c45", baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97", shopifyHandle: "cotton-tote" },
].map(record => ({ ...record, designId: performanceDesignId, designRevisionId: performanceRevisionId,
    placement: { depth: 5, width: 0.22, x: 0.39, y: 0.43 }, projectionVersion: "safe-margin-v1",
    defaultColor: "White", createdAt: "2026-09-06T00:00:00Z" }));
for (const record of performanceFamily) {
    api.intercept({ path: `/v2/internal/configured-products/${record.id}/purchase-readiness` }).reply(200, { ready: true }, { headers }).persist();
    api.intercept({ path: `/v1/products/${record.id}` }).reply(200, record, { headers }).persist();
    api.intercept({ path: `/v1/products/${record.id}/family` }).reply(200, performanceFamily, { headers }).persist();
}
api.intercept({ path: `/v1/designs/${performanceDesignId}` }).reply(200, {
    id: performanceDesignId, status: "ready", contentType: "image/png", artworkRevision: "a".repeat(64),
    createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z", artworkUrl: "/fixture/artwork",
    settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.39, placementY: 0.43, placementWidth: 0.22, depth: 5 },
}, { headers }).persist();
api.intercept({ path: new RegExp(`^/v1/designs/${performanceDesignId}/artwork/preview\\?`) }).reply(200, readFileSync(new URL("./artwork.png", import.meta.url)), { headers: { "content-type": "image/png" } }).persist();
// Source preparation is deliberately unfinished throughout the shopping journey.
const pendingDesignId = protectedConfig("resource_83abf907850d");
const pendingFamily = performanceFamily.map((record, index) => ({ ...record,
    id: `${index + 6}c22bf7e-e698-4a0a-90c4-66c5549f1c45`, designId: pendingDesignId,
    designRevisionId: null, preparationId: pendingDesignId,
}));
for (const record of pendingFamily) {
    api.intercept({ path: `/v1/products/${record.id}` }).reply(200, record, { headers }).persist();
    api.intercept({ path: `/v1/products/${record.id}/family` }).reply(200, pendingFamily, { headers }).persist();
    api.intercept({ path: `/v2/internal/configured-products/${record.id}/purchase-readiness` }).reply(200, { ready: false }, { headers }).persist();
    api.intercept({ path: `/v2/internal/configured-products/${record.id}/preview/${pendingDesignId}` }).reply(200, readFileSync(new URL("./artwork.png", import.meta.url)), { headers: { "content-type": "image/png",
            "x-product-preview": JSON.stringify({ revision: pendingDesignId,
                baseProductSlug: record.shopifyHandle === "bent-shirt" ? "staple-tee" : "cotton-tote",
                settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.39, placementY: 0.43, placementWidth: 0.22, depth: 5 } }),
        } }).persist();
    for (const method of ["GET", "HEAD"]) {
        api.intercept({ method, path: new RegExp(`^/v2/internal/configured-products/${record.id}/images/`) })
            .reply(202, "", { headers: { "cache-control": "private, no-store", "retry-after": "2" } }).persist();
    }
}
// Authoritative image service fixtures replace the former in-Vercel compositor.
// Keep real BFF routing and carousel image decoding in the browser gate.
const storedFlat = {
    black: readFileSync(new URL("../../public/mockups/tee-black-cutout-v1.png", import.meta.url)),
    white: readFileSync(new URL("../../public/mockups/tee-white-cutout-v1.png", import.meta.url)),
};
const storedLifestyle = {
    black: readFileSync(new URL("../../../../assets/lifestyle/featured-blank-black.png", import.meta.url)),
    white: readFileSync(new URL("../../../../assets/lifestyle/featured-blank-white.png", import.meta.url)),
};
for (const method of ["GET", "HEAD"]) {
    for (const view of ["flat", "lifestyle"]) {
        api.intercept({ method, path: new RegExp(`^/v2/internal/configured-products/[a-f0-9-]{36}/images/${view}/(black|white|cream)\\?`) }).reply(options => {
            const color = options.path.includes(`/${view}/black?`) ? "black" : "white";
            return { statusCode: 200,
                data: method === "HEAD" ? "" : view === "flat" ? storedFlat[color] : storedLifestyle[color],
                responseOptions: { headers: { "content-type": "image/png", etag: `"fixture-${view}-${color}-v1"`, "cache-control": "no-store" } },
            };
        }).persist();
    }
}
// A real creation/grant BFF boundary for the aged-clearance phone regression.
agent.get("https://challenges.cloudflare.com").intercept({ path: "/turnstile/v0/siteverify", method: "POST" })
    .reply(options => ({ statusCode: 200, data: JSON.stringify({ success: !String(options.body).includes("fixture-rejected-token"), hostname: "example.com" }), responseOptions: { headers } })).persist();
api.intercept({ path: "/v2/design-drafts", method: "POST" })
    .reply(201, { id: pendingDesignId, version: 0 }, { headers }).persist();
api.intercept({ path: `/v2/design-drafts/${pendingDesignId}/upload-grants`, method: "POST" })
    .reply(201, { uploadUrl: "http://localhost:4317/fixture-upload", expiresAt: "2099-01-01T00:00:00Z" }, { headers }).persist();
