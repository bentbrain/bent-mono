import { protectedConfig } from "../../../scripts/protected-config.mjs";
import sharp from "sharp";
import { expect, test } from "./test";
test.use({ baseURL: "http://localhost:4317" });
for (const failure of ["none", "manual-retry", "version-conflict", "aged-clearance"]) {
    const agedClearance = failure === "aged-clearance";
    const failReplacement = failure === "manual-retry";
    const conflictReplacement = failure === "version-conflict";
    const suffix = failReplacement ? " after an upload retry" : conflictReplacement ? " after a background version conflict" : agedClearance ? " after clearance expiry" : "";
    test(`retake replaces the rendered photo${suffix}`, async ({ page }, testInfo) => {
        if (agedClearance)
            test.setTimeout(60000);
        // This case checks replacement pixels/upload ordering, not elapsed time.
        // Install before navigation so every application timer uses the same clock.
        await page.clock.install();
        await page.emulateMedia({ reducedMotion: "reduce" });
        const id = protectedConfig("resource_83abf907850d");
        const settings = { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.3, placementY: 0.3, placementWidth: 0.2, depth: 5 };
        const previews = await Promise.all(["#ee2222", "#2244ee"].map(background => sharp({
            create: { width: 640, height: 480, channels: 4, background },
        }).webp().toBuffer()));
        let version = 0;
        let uploads = 0;
        let grants = 0;
        let ready = false;
        let colorReads = 0;
        await page.addInitScript(() => {
            navigator.mediaDevices.getUserMedia = async () => {
                const canvas = document.createElement("canvas");
                canvas.width = 640;
                canvas.height = 480;
                const context = canvas.getContext("2d");
                if (context) {
                    context.fillStyle = "#888888";
                    context.fillRect(0, 0, 640, 480);
                }
                return canvas.captureStream(15);
            };
            window.turnstile = {
                render(_container, options) { queueMicrotask(() => options.callback("local-token")); return "local-widget"; },
                remove() { }, reset() { },
            };
        });
        await page.route("**/api/design-drafts**", async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (agedClearance && path === "/api/design-drafts" && request.method() === "POST") {
                const response = await route.fetch();
                const headers = response.headers();
                headers["set-cookie"] = (headers["set-cookie"] ?? "").replace("Max-Age=900", "Max-Age=10");
                return route.fulfill({ response, headers });
            }
            if (path === "/api/design-drafts") {
                return route.fulfill({ json: request.method() === "POST" ? { id, version } : { items: [], nextCursor: null } });
            }
            if (path.endsWith("/upload-grants")) {
                const payload: unknown = request.postDataJSON();
                expect(payload).toMatchObject({ expectedVersion: version });
                grants += 1;
                if (agedClearance) {
                    if (grants === 2) {
                        await expect.poll(async () => (await page.context().cookies()).some(cookie => cookie.name === "__Host-forever_tee_abuse"), { timeout: 15000 }).toBe(false);
                    }
                    return route.fallback();
                }
                return route.fulfill({ json: { uploadUrl: `http://localhost:4317/fixture-upload?grant=${String(grants)}`, expiresAt: "2099-01-01T00:00:00Z" } });
            }
            if (path === `/api/design-drafts/${id}` && request.method() === "GET") {
                if (ready)
                    colorReads += 1;
                return route.fulfill({ json: {
                        id, version, finalized: false, status: ready ? "ready" : "creating", contentType: "image/png",
                        artworkRevision: (uploads > 1 ? "b" : "a").repeat(64), artworkUrl: "/fixture/artwork",
                        createdAt: "2026-09-06T00:00:00Z", updatedAt: `2026-09-06T00:00:${String(version).padStart(2, "0")}Z`,
                        settings, defaultColor: uploads === 1 && colorReads > 1 ? "Black" : "White",
                        defaultColorStatus: ready && colorReads < 2 ? "pending" : "complete",
                    } });
            }
            if (path === `/api/design-drafts/${id}` && request.method() === "PATCH") {
                expect(ready, "Placement saves must not race replacement uploads").toBe(true);
                expect(request.postDataJSON()).toMatchObject({ expectedVersion: version });
                version += 1;
                return route.fulfill({ json: { id, version, updatedAt: `2026-09-06T00:00:${String(version).padStart(2, "0")}Z` } });
            }
            throw new Error(`Unexpected draft request: ${request.method()} ${path}`);
        });
        await page.route("**/fixture-upload**", async (route) => {
            uploads += 1;
            ready = false;
            await new Promise(resolve => setTimeout(resolve, 350));
            if (failReplacement && uploads === 2) {
                return route.fulfill({ status: 400, json: { error: { code: "BAD_REQUEST", message: "Fixture upload failed." } } });
            }
            if (conflictReplacement && uploads === 2) {
                // Full-resolution preparation completes while the replacement transfers.
                version += 1;
                ready = true;
                return route.fulfill({ status: 409, json: { error: { code: "VERSION_CONFLICT", message: "The draft changed or this grant was already used." } } });
            }
            ready = true;
            colorReads = 0;
            version += 1;
            const preview = previews[uploads === 1 ? 0 : 1];
            if (!preview)
                throw new Error("Missing preview fixture.");
            return route.fulfill({ json: {
                    id, version, artworkUrl: "/fixture/artwork", updatedAt: `2026-09-06T00:00:${String(version).padStart(2, "0")}Z`,
                    preview: { contentType: "image/webp", base64: preview.toString("base64") },
                } });
        });
        await page.route("**/api/product-availability", route => route.fulfill({ json: { available: true } }));
        await page.route("**/api/creation-trace", route => route.fulfill({ status: 204 }));
        const canvas = page.locator("canvas.editor-direct-manipulation-cue");
        const photoColor = () => canvas.evaluate(element => {
            if (!(element instanceof HTMLCanvasElement))
                throw new Error("Expected editor canvas.");
            const pixel = element.getContext("2d")?.getImageData(500, 600, 1, 1).data;
            if (!pixel || pixel[3] === 0)
                return "blank";
            return (pixel[0] ?? 0) > (pixel[2] ?? 0) ? "red" : "blue";
        });
        const expectPreviews = async (shirt: string, tote: string) => {
            await expect(page.locator('[data-editor-minimap="staple-tee"] img')).toHaveAttribute("src", new RegExp(`tee-${shirt}`));
            await expect(page.locator('[data-editor-minimap="cotton-tote"] img')).toHaveAttribute("src", new RegExp(`tote-${tote}`));
        };
        await page.goto("/create");
        // This test exercises retake pixels. Let the saved-design layout settle
        // before clicking so its loading row cannot move the button mid-click.
        await expect(page.getByRole("status").filter({ hasText: "Loading designs" })).toHaveCount(0);
        await expect(page.getByRole("alert").filter({ hasText: "Your saved designs couldn't be loaded." })).toHaveCount(0);
        await page.getByRole("checkbox").check();
        await page.getByRole("button", { name: "Open camera", exact: true }).click();
        // Navigation includes declaration persistence and cold development compilation.
        await page.waitForURL(/\/design\/[0-9a-f-]+\?camera=1$/);
        await page.getByRole("button", { name: "Take photo in 3 seconds" }).click();
        await page.clock.runFor(3000);
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
        await expect.poll(photoColor, { timeout: 15000 }).toBe("red");
        await expectPreviews("black", "black");
        await page.getByRole("button", { name: "Take another photo" }).click();
        await page.getByRole("button", { name: "Cancel retake" }).click();
        await expect.poll(photoColor).toBe("red");
        await page.getByRole("button", { name: "Take another photo" }).click();
        await page.getByRole("button", { name: "Take photo in 3 seconds" }).click();
        await page.clock.runFor(3000);
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
        if (failReplacement || agedClearance) {
            await expect(page.getByRole("main").getByRole("alert")).toContainText("We couldn't prepare your artwork.", { timeout: agedClearance ? 20000 : 5000 });
            await expect(canvas).toHaveCount(0);
            await page.getByRole("button", { name: "Try again", exact: true }).click();
        }
        await expect.poll(photoColor, { timeout: 15000 }).toBe("blue");
        await expectPreviews("white", "cream");
        const bounds = await canvas.boundingBox();
        if (!bounds)
            throw new Error("Expected canvas bounds.");
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width / 2 + 15, bounds.y + bounds.height / 2);
        await page.mouse.up();
        await expect.poll(photoColor).toBe("blue");
        await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
        expect(uploads).toBe(failReplacement || conflictReplacement ? 3 : 2);
        expect(grants).toBe(uploads + (agedClearance ? 1 : 0));
        await page.screenshot({ path: testInfo.outputPath("retake-mobile.png"), fullPage: true });
    });
}
