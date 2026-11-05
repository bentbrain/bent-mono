import { expect, test } from "./test";
import { selectShirtSize } from "./helpers";
for (const width of [390, 1440]) {
    test(`header retains its vertical spacing when the page height is constrained at ${String(width)}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto("/");
        await expect(page.getByRole("region", { name: "Products", exact: true })).toBeVisible();
        const header = page.getByRole("banner");
        const normalHeight = await header.evaluate(element => element.getBoundingClientRect().height);
        expect(normalHeight).toBe(48);
        await page.evaluate(() => {
            document.body.style.height = "100%";
        });
        await expect.poll(() => header.evaluate(element => element.getBoundingClientRect().height)).toBe(normalHeight);
        const spacing = await header.evaluate(element => {
            const link = element.querySelector("a");
            if (!link)
                throw new Error("Header link is missing");
            return link.getBoundingClientRect().top - element.getBoundingClientRect().top;
        });
        expect(spacing).toBeGreaterThanOrEqual(15);
    });
    test(`size selection waits for its handlers and retains the first choice at ${String(width)}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        const scripts = Promise.withResolvers<void>();
        await page.route("**/_next/static/**/*.js", async (route) => {
            await scripts.promise;
            await route.continue();
        });
        try {
            await page.goto("/featured/" + "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4" + "?shirtColor=White", { waitUntil: "commit" });
            const size = page.getByRole("combobox", { name: "Size" });
            await expect(size).toBeVisible();
            await expect(size).toBeDisabled();
            scripts.resolve();
            await selectShirtSize(page, "M");
            await page.getByRole("tab", { name: "tote", exact: true }).click();
            await expect(size).toHaveCount(0);
            await page.getByRole("tab", { name: "t-shirt", exact: true }).click();
            await expect(size).toContainText("M");
            await expect(page).toHaveURL(/shirtSize=M/);
            await page.screenshot({ path: testInfo.outputPath("hydrated-size-selection.png"), fullPage: true });
        }
        finally {
            scripts.resolve();
        }
    });
    test(`landing grid has three square columns and a final create tile at ${String(width)}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        const gallery = page.getByRole("region", { name: "Products", exact: true });
        const featured = gallery.getByRole("link", { name: /Open featured design/ });
        await expect(featured.first()).toBeVisible();
        await expect(page).toHaveURL(/\/$/);
        const grid = gallery.locator(".grid").first();
        expect(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(3);
        const box = await featured.first().boundingBox();
        expect(box).not.toBeNull();
        expect(Math.abs((box?.width ?? 0) - (box?.height ?? 1))).toBeLessThan(1);
        await expect(gallery.getByRole("link").last()).toHaveAccessibleName("Make your own");
        await expect(gallery.getByRole("link").last()).toHaveAttribute("href", "/create");
        await expect(page.getByRole("button", { name: /Shuffle/ })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await expect.poll(() => featured.first().locator("img").evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0), { timeout: 15000 }).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`landing-grid-${String(width)}.png`), fullPage: true });
        const href = await featured.first().getAttribute("href");
        await featured.first().focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => new URL(page.url()).pathname).toBe(href);
        await expect(page.getByRole("tab", { name: "t-shirt", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: /Shuffle/ })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath(`featured-page-${String(width)}.png`), fullPage: true });
        await page.getByRole("link", { name: "bent.shop", exact: true }).click();
        await gallery.getByRole("link", { name: "Make your own", exact: true }).click();
        await expect(page).toHaveURL(/\/create$/);
        await expect(page.getByRole("region", { name: "Products", exact: true })).toHaveCount(0);
    });
}
test("numbered links retain their design, selection and metadata on stable routes", async ({ page }) => {
    await page.goto("/?featured=1&product=tote&toteColor=Black");
    await expect(page).toHaveURL(/\/featured\/[^?]+\?product=tote&toteColor=Black/);
    const chosen = new URL(page.url()).pathname;
    await expect(page.getByRole("tab", { name: "tote", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "t-shirt", exact: true }).click();
    await expect(page).toHaveURL(/[?&]product=shirt(?:&|$)/);
    await page.getByRole("tab", { name: "tote", exact: true }).click();
    await expect(page).toHaveURL(/[?&]product=tote(?:&|$)/);
    await page.reload();
    expect(new URL(page.url()).pathname).toBe(chosen);
    await expect(page.getByRole("tab", { name: "tote", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", new RegExp(`${chosen}\\?toteColor=Black&product=tote$`));
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://shop.bent.build${chosen}`);
});
test("existing unnumbered product links retain the original featured design", async ({ page }) => {
    await page.goto("/?product=tote&toteColor=Black");
    await expect(page).toHaveURL(/\/featured\//);
    await expect(page.getByRole("tab", { name: "tote", exact: true })).toHaveAttribute("aria-selected", "true");
});
test("unknown featured slugs cannot publish a visitor product", async ({ page }) => {
    await page.goto("/featured/4c22bf7e-e698-4a0a-90c4-66c5549f1c45");
    await expect(page.getByRole("heading", { name: "Page not found.", exact: true })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
});
for (const width of [390, 1440]) {
    test(`product switches become usable only after their handlers are ready at ${String(width)}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        const scripts = Promise.withResolvers<void>();
        await page.route("**/_next/static/**/*.js", async (route) => {
            await scripts.promise;
            await route.continue();
        });
        try {
            await page.goto("/featured/" + "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4" + "?product=tote&toteColor=Black", { waitUntil: "commit" });
            const shirt = page.getByRole("tab", { name: "t-shirt", exact: true });
            await expect(shirt).toBeVisible();
            await expect(shirt).toBeDisabled();
            scripts.resolve();
            await shirt.click();
            await expect(shirt).toHaveAttribute("aria-selected", "true");
            await expect(page).toHaveURL(/[?&]product=shirt(?:&|$)/);
            await page.getByRole("tab", { name: "tote", exact: true }).click();
            await expect(page).toHaveURL(/[?&]product=tote(?:&|$)/);
            await page.screenshot({ path: testInfo.outputPath("hydrated-product-switch.png"), fullPage: true });
        }
        finally {
            scripts.resolve();
        }
    });
}
