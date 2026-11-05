import { protectedConfig } from "../../../scripts/protected-config.mjs";
import { expect, test } from "./test";
import { selectShirtSize } from "./helpers";
import { resolve } from "node:path";
import { installCameraPreviewFixture } from "./local/camera-preview-fixture";
import type { CartDataFromHandlers } from "@shopify/hydrogen";
import type { cartHandlers } from "../src/lib/cart-handlers";
test("empty cart links to creation from the page and drawer", async ({ page }, testInfo) => {
    await page.goto("/cart");
    const makeYourOwn = page.getByRole("link", { name: "Make your own", exact: true });
    await expect(makeYourOwn).toHaveAttribute("href", "/create");
    await page.screenshot({ path: testInfo.outputPath("empty-cart-page.png"), style: "nextjs-portal { visibility: hidden; }" });
    await makeYourOwn.click();
    await expect(page).toHaveURL(/\/create$/);
    await page.getByRole("banner").getByRole("link", { name: "cart", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Cart", exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Make your own", exact: true })).toHaveAttribute("href", "/create");
    await drawer.getByRole("button", { name: "Close cart", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(drawer.getByRole("link", { name: "Make your own", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    const trigger = page.getByRole("banner").getByRole("link", { name: "cart", exact: true });
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(drawer).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("empty-cart-drawer.png"), style: "nextjs-portal { visibility: hidden; }" });
    await drawer.getByRole("link", { name: "Make your own", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\/create$/);
});
test("pending artwork persists in the cart and blocks only checkout", async ({ page }, testInfo) => {
    let artworkReady = false;
    await page.route("**/api/product-purchase-readiness/*", route => route.fulfill({ json: { ready: artworkReady } }));
    await page.goto("/cart");
    await expect(page.getByText("Your cart is empty.", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Make your own", exact: true }).click();
    await expect(page).toHaveURL(/\/create$/);
    await page.getByRole("banner").getByRole("link", { name: "cart", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Cart", exact: true });
    await expect(drawer).toBeVisible();
    // Drive the real Hydrogen store and cart page while providers remain fixture-only.
    await page.evaluate(() => {
        const money: CartDataFromHandlers<typeof cartHandlers>["cost"]["subtotalAmount"] = { amount: "35.00", currencyCode: "AUD" };
        const selectedOptions = [{ name: "Color", value: "Black" }, { name: "Size", value: "M" }];
        const cart: CartDataFromHandlers<typeof cartHandlers> = {
            id: "gid://shopify/Cart/fixture", attributes: [], note: null, discountCodes: [],
            checkoutUrl: "https://example.myshopify.com/cart/fixture", totalQuantity: 1,
            cost: { subtotalAmount: money, totalAmount: money, checkoutChargeAmount: money },
            lines: { nodes: [{
                        id: "gid://shopify/CartLine/fixture", quantity: 1, attributes: [{ key: "_productId", value: "4c22bf7e-e698-4a0a-90c4-66c5549f1c45" }, { key: "_lineCapability", value: "i1.pending.signature" }],
                        cost: { amountPerQuantity: money, compareAtAmountPerQuantity: null, subtotalAmount: money, totalAmount: money },
                        merchandise: {
                            id: "gid://shopify/ProductVariant/fixture", title: "Black / M", sku: null, image: null, selectedOptions,
                            product: {
                                id: "gid://shopify/Product/fixture", handle: "fixture", title: "bent.shop", vendor: "bent.shop", productType: "T-shirt",
                                options: selectedOptions.map(({ name, value }) => ({ name, optionValues: [{ name: value }] })),
                                variants: { nodes: [{ id: "gid://shopify/ProductVariant/fixture", availableForSale: true, selectedOptions }] },
                            },
                        },
                    }] },
        };
        const promise = new Promise((resolve) => {
            document.addEventListener("fixture:confirm-cart", () => resolve({ cart: { ...cart, lines: cart.lines.nodes }, userErrors: [], warnings: [] }), { once: true });
        });
        document.dispatchEvent(Object.assign(new Event("shopify:cart:lines-update"), {
            action: "add", lines: [{ merchandiseId: "gid://shopify/ProductVariant/fixture", quantity: 1 }],
            detail: { products: [{ id: "gid://shopify/ProductVariant/fixture", title: "Black / M", image: null, price: money, selectedOptions, product: { handle: "fixture", title: "bent.shop" } }] },
            promise,
        }));
    });
    for (const value of ["Color: Black", "Size: M"]) {
        await expect(drawer.getByLabel(value, { exact: true })).toHaveCSS("text-transform", "uppercase");
    }
    await expect(drawer.getByRole("link", { name: "Checkout", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("cart-pending.png"), style: "nextjs-portal { visibility: hidden; }" });
    await page.evaluate(() => document.dispatchEvent(new Event("fixture:confirm-cart")));
    for (const name of ["Color", "Size"]) {
        await expect(drawer.getByRole("combobox", { name: `${name} for bent.shop` })).toHaveCSS("text-transform", "uppercase");
    }
    await expect(drawer.getByRole("button", { name: "Preparing artwork…", exact: true })).toBeDisabled();
    await expect(drawer.getByText("Preparing artwork… You can keep shopping.", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Increase quantity of bent.shop", exact: true })).toBeEnabled();
    // The first configured-image request also compiles its Next dev route on CI.
    // Keep this loaded-image/layout check separate from deployed latency limits.
    await expect.poll(() => drawer.locator("article img").evaluateAll(images => images.length > 0 && images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)), { timeout: 15000 }).toBe(true);
    await expect(drawer.getByText("Preparing artwork… You can keep shopping.", { exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("cart-artwork-preparing.png"), style: "nextjs-portal { visibility: hidden; }" });
    artworkReady = true;
    await expect(drawer.getByRole("link", { name: "Checkout", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("cart-confirmed.png"), style: "nextjs-portal { visibility: hidden; }" });
});
test.describe("pending source artwork", () => {
    test.use({ baseURL: "http://localhost:4317" });
    test("unfinished photo reaches both products and the cart while only checkout waits", async ({ page }, testInfo) => {
        // Includes upload, both products, refresh and cart on the development server.
        test.setTimeout(60000);
        await installCameraPreviewFixture(page, () => Promise.resolve("success"), 2.6, true);
        // Compile the fixture BFF before exercising the browser fallback deadline.
        // Production routes are prebuilt; this request cannot seed its bitmap cache.
        const preview = await page.request.get("/api/product-preview/6c22bf7e-e698-4a0a-90c4-66c5549f1c45/" + protectedConfig("resource_83abf907850d"));
        expect(preview.status()).toBe(200);
        let ready = false;
        await page.route("**/api/product-purchase-readiness/*", route => route.fulfill({ json: { ready } }));
        if (testInfo.project.name === "local-mobile") {
            await page.goto("/create");
            await page.getByRole("checkbox").check();
            await page.locator('input[type="file"]').setInputFiles(resolve("e2e/local/artwork.png"));
            await page.getByRole("button", { name: "Confirm", exact: true }).click();
            await expect(page.getByText("Preparing print-quality photo…", { exact: true })).toBeVisible();
            // Finalization polling must not redirect back to Create while the product
            // response is in flight. Reproduce the deployed handoff race locally.
            await page.route(/\/product\/6c22bf7e[^/?]*(?:\?|$)/, async (route) => {
                await new Promise(resolve => setTimeout(resolve, 1500));
                await route.continue();
            });
            await page.getByRole("button", { name: "Continue", exact: true }).click();
            await expect(page).toHaveURL(/\/product\/6c22bf7e/);
        }
        else {
            await page.goto("/product/6c22bf7e-e698-4a0a-90c4-66c5549f1c45");
        }
        // Refresh loses the in-memory editor bitmap: recover the frozen preview recipe.
        await page.reload();
        // Next dev can rebuild the fallback route during this refresh on CI.
        // This fixture recovery check is separate from deployed preview deadlines.
        await expect(page.locator('canvas[data-browser-preview="flat"][data-preview-ready="true"]').first()).toBeVisible({ timeout: 15000 });
        await page.screenshot({ path: testInfo.outputPath("pending-source-products.png"), style: "nextjs-portal { visibility: hidden; }" });
        await page.getByRole("tab", { name: "tote", exact: true }).click();
        await expect(page.getByRole("button", { name: /Add to cart$/ })).toBeEnabled();
        await expect(page.getByRole("tabpanel", { name: "tote", exact: true }).locator('[data-variant-active="true"] canvas[data-preview-ready="true"]').first()).toBeVisible();
        await page.getByRole("tab", { name: "t-shirt", exact: true }).click();
        const shirt = page.getByRole("tabpanel", { name: "t-shirt", exact: true });
        await shirt.getByRole("link", { name: "Color: White", exact: true }).click();
        await expect(shirt.locator('[data-variant-active="true"] canvas[data-browser-preview="flat"][data-preview-ready="true"]').first()).toBeVisible();
        await shirt.getByRole("link", { name: "Color: Black", exact: true }).click();
        await expect(shirt.locator('[data-variant-active="true"] canvas[data-browser-preview="flat"][data-preview-ready="true"]').first()).toBeVisible();
        await shirt.getByRole("link", { name: "Color: White", exact: true }).click();
        // Read immediately: a retrying expectation would hide the repeated delay.
        expect(await shirt.locator('[data-variant-active="true"]').getByText("Preparing preview…", { exact: true }).count()).toBe(0);
        await shirt.getByRole("link", { name: "Color: Black", exact: true }).click();
        await selectShirtSize(page, "M");
        await expect(page.getByRole("button", { name: /Add to cart$/ })).toBeEnabled();
        // Local standard-actions fixture: backend tests separately exercise issuance
        // and checkout verification of the real signed intent against D1 and R2.
        await page.evaluate((designId) => {
            const money: CartDataFromHandlers<typeof cartHandlers>["cost"]["subtotalAmount"] = { amount: "35.00", currencyCode: "AUD" };
            const selectedOptions = [{ name: "Color", value: "Black" }, { name: "Size", value: "M" }];
            const cart: CartDataFromHandlers<typeof cartHandlers> = {
                id: "gid://shopify/Cart/fixture", attributes: [], note: null, discountCodes: [],
                checkoutUrl: "https://example.myshopify.com/cart/fixture", totalQuantity: 1,
                cost: { subtotalAmount: money, totalAmount: money, checkoutChargeAmount: money },
                lines: { nodes: [{
                            id: "gid://shopify/CartLine/fixture", quantity: 1, attributes: [{ key: "_productId", value: "6c22bf7e-e698-4a0a-90c4-66c5549f1c45" }, { key: "_lineCapability", value: "i1.pending.signature" }, { key: "_designId", value: designId }],
                            cost: { amountPerQuantity: money, compareAtAmountPerQuantity: null, subtotalAmount: money, totalAmount: money },
                            merchandise: {
                                id: "gid://shopify/ProductVariant/fixture", title: "Black / M", sku: null, image: null, selectedOptions,
                                product: {
                                    id: "gid://shopify/Product/fixture", handle: "fixture", title: "bent.shop", vendor: "bent.shop", productType: "T-shirt",
                                    options: selectedOptions.map(({ name, value }) => ({ name, optionValues: [{ name: value }] })),
                                    variants: { nodes: [{ id: "gid://shopify/ProductVariant/fixture", availableForSale: true, selectedOptions }] },
                                },
                            },
                        }] },
            };
            const result = { cart: { ...cart, lines: cart.lines.nodes }, userErrors: [], warnings: [] };
            if (!window.Shopify)
                throw new Error("Shopify fixture was not initialized");
            Object.assign(window.Shopify, { actions: { updateCart: Object.assign(async () => {
                        document.dispatchEvent(Object.assign(new Event("shopify:cart:lines-update"), {
                            action: "add", lines: [{ merchandiseId: "gid://shopify/ProductVariant/fixture", quantity: 1 }],
                            detail: { products: [{ id: "gid://shopify/ProductVariant/fixture", title: "Black / M", image: null, price: money, selectedOptions, product: { handle: "fixture", title: "bent.shop" } }] },
                            promise: Promise.resolve(result),
                        }));
                        return result;
                    }, { isDefault: () => false }) } });
        }, protectedConfig("resource_83abf907850d"));
        await page.getByRole("button", { name: /Add to cart$/ }).click();
        const drawer = page.getByRole("dialog", { name: "Cart", exact: true });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole("button", { name: "Preparing artwork…", exact: true })).toBeDisabled();
        await expect(drawer.getByRole("button", { name: "Increase quantity of bent.shop", exact: true })).toBeEnabled();
        await expect(drawer.locator('canvas[data-preview-ready="true"]')).toBeVisible();
        await expect(drawer.getByRole("link", { name: "Checkout", exact: true })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("pending-source-cart.png"), style: "nextjs-portal { visibility: hidden; }" });
        ready = true;
        await expect(drawer.getByRole("link", { name: "Checkout", exact: true })).toBeVisible();
    });
});
