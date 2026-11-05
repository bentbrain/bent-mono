import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { requestCrawlerPage } from "./crawler-request";
// Raw crawler responses must not include Vercel's optional cookie-setting
// redirect. Authenticate these requests with the header alone.
const protectionBypass = process.env["VERCEL_AUTOMATION_BYPASS_SECRET"];
test.use({
    extraHTTPHeaders: protectionBypass
        ? { "x-vercel-protection-bypass": protectionBypass }
        : {},
});
const productId = "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4";
const noindex = /<meta name="robots" content="noindex, nofollow"\s*\/?\s*>/;
// Each route keeps its own request/assertion deadline. A cold Next dev server
// compiles these routes separately; batching all six consumed one test budget.
for (const userAgent of ["Googlebot", "bingbot"]) {
    for (const path of [
        "/create",
        "/create/camera",
        `/design/${productId}`,
        `/design/${productId}/cotton-tote`,
        `/product/${productId}?Color=White`,
        `/products/${productId}`,
    ]) {
        test(`customer routes emit noindex for ${userAgent}: ${path}`, async ({ request }) => {
            const response = await requestCrawlerPage(request, path, userAgent);
            expect(response.ok(), path).toBe(true);
            const html = await response.text();
            expect(html, path).toMatch(noindex);
        });
    }
}
test("public discovery lists only the canonical storefront", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    expect(robots.headers()["content-type"]).toContain("text/plain");
    const rules = await robots.text();
    expect(rules).toContain("User-Agent: *\nAllow: /");
    expect(rules).not.toContain("Disallow:");
    expect(rules).toContain("Sitemap: https://shop.bent.build/sitemap.xml");
    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    expect(sitemap.headers()["content-type"]).toContain("application/xml");
    expect((await sitemap.text()).match(/<loc>[^<]+<\/loc>/g)).toEqual([
        "<loc>https://shop.bent.build/</loc>",
    ]);
});
async function expectProductSharing(page: Page, color: string) {
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://shop.bent.build/product/${productId}`);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", `https://shop.bent.build/product/${productId}?Color=${color}`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", new RegExp(`/product/${productId}/${color.toLowerCase()}\\.png$`));
}
test("browser navigation preserves default product sharing and public indexing", async ({ page }) => {
    await page.goto(`/product/${productId}`);
    // Read the selected product control independently of the metadata under test.
    // The deployed catalogue can change its default without changing this spec.
    const selectedColor = page.getByRole("link", { name: /^Color:/ })
        .and(page.locator('[aria-current="true"]'));
    await expect(selectedColor).toHaveCount(1);
    await expect(selectedColor).toHaveAttribute("aria-label", /^Color: (White|Black)$/);
    const label = await selectedColor.getAttribute("aria-label");
    if (label !== "Color: White" && label !== "Color: Black") {
        throw new Error(`Unexpected selected product colour: ${label}`);
    }
    await expectProductSharing(page, label.slice("Color: ".length));
    await page.goto("/");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://shop.bent.build");
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
});
for (const color of ["White", "Black"]) {
    test(`explicit ${color} selection agrees with product sharing`, async ({ page }) => {
        await page.goto(`/product/${productId}?Color=${color}`);
        await expect(page.getByRole("link", { name: `Color: ${color}`, exact: true }))
            .toHaveAttribute("aria-current", "true");
        await expectProductSharing(page, color);
    });
}
