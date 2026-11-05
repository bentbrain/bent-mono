import { protectedConfig } from "../../../scripts/protected-config.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { expect, test } from "./test";
import { installCameraPreviewFixture } from "./local/camera-preview-fixture";
test.use({ baseURL: "http://localhost:4317" });
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => {
            document.documentElement.dataset["cameraRequested"] = "true";
            return Promise.reject(new Error("Upload must not request camera access."));
        };
    });
});
for (const format of ["jpeg", "png", "webp"] satisfies Array<"jpeg" | "png" | "webp">) {
    test(`${format} upload reaches review and editor without camera access`, async ({ page }, testInfo) => {
        const fixture = await installCameraPreviewFixture(page, () => Promise.resolve("success"));
        const source = sharp(resolve("e2e/local/artwork.png"));
        const original = await source.metadata();
        const image = await (format === "jpeg" ? source.withMetadata({ orientation: 6 }) : format === "webp" ? source.resize({ width: 5000 }) : source).toFormat(format).toBuffer();
        await page.goto("/create");
        await expect(page.getByRole("img", { name: "QR code to continue creating this design on a phone", includeHidden: true })).toHaveCount(0);
        if (format === "png")
            await page.screenshot({ path: testInfo.outputPath("create-upload-mobile.png"), style: "nextjs-portal { visibility: hidden; }" });
        await page.getByRole("button", { name: "Upload image", exact: true }).click();
        await expect(page.getByRole("checkbox")).not.toBeChecked();
        expect(fixture.uploads()).toBe(0);
        await page.getByRole("checkbox").check();
        const chooserPromise = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "Upload image", exact: true }).click();
        const chooser = await chooserPromise;
        const uploadRequest = page.waitForRequest("**/fixture-upload");
        await chooser.setFiles({ name: `portrait.${format}`, mimeType: `image/${format}`, buffer: image });
        await expect(page).toHaveURL(/\/design\/[0-9a-f-]+\?upload=1$/);
        await expect(page.getByRole("img", { name: "Your uploaded photo" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Choose another", exact: true })).toBeVisible();
        const bytes = (await uploadRequest).postDataBuffer();
        if (!bytes)
            throw new Error("Expected image upload bytes.");
        const metadata = await sharp(bytes).metadata();
        expect(bytes.equals(image)).toBe(true);
        expect(metadata.format).toBe(format);
        if (format === "webp")
            expect(metadata.width).toBe(5000);
        if (format === "jpeg") {
            expect(metadata.width).toBe(original.width);
            expect(metadata.height).toBe(original.height);
            expect(metadata.orientation).toBe(6);
        }
        if (format === "png")
            await page.screenshot({ path: testInfo.outputPath("upload-review-mobile.png"), style: "nextjs-portal { visibility: hidden; }" });
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
        await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
        await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
        if (format === "png") {
            await page.screenshot({ path: testInfo.outputPath("upload-editor-mobile.png"), style: "nextjs-portal { visibility: hidden; }" });
            const background = page.getByRole("checkbox", { name: "Background", exact: true });
            const recursive = page.getByRole("checkbox", { name: "Effect", exact: true });
            await expect(background).not.toBeChecked();
            await expect(recursive).toBeChecked();
            const sourceReady = Promise.withResolvers<void>();
            await page.route("**/artwork-sources/original", async (route) => {
                await sourceReady.promise;
                await route.fallback();
            });
            const canvasBefore = await page.locator("canvas.editor-direct-manipulation-cue").boundingBox();
            const optionsBefore = await page.getByRole("group", { name: "Design options" }).boundingBox();
            await background.check();
            try {
                await expect(page.getByText("Updating photo…")).toBeVisible();
                expect(await page.locator("canvas.editor-direct-manipulation-cue").boundingBox()).toEqual(canvasBefore);
                expect(await page.getByRole("group", { name: "Design options" }).boundingBox()).toEqual(optionsBefore);
            }
            finally {
                sourceReady.resolve();
            }
            await expect(background).toBeChecked();
            await recursive.uncheck();
            await expect.poll(() => fixture.settings().removeBackground).toBe(false);
            await expect.poll(() => fixture.settings().depth).toBe(0);
            const canvas = page.locator("canvas.editor-direct-manipulation-cue");
            const bounds = await canvas.boundingBox();
            if (!bounds)
                throw new Error("Canvas missing");
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            await page.mouse.down();
            await page.mouse.move(bounds.x + bounds.width / 2 + 10, bounds.y + bounds.height / 2 + 10);
            for (const preview of await page.locator("[data-editor-minimap]").all())
                await expect(preview).toHaveCSS("opacity", "0.8");
            await page.screenshot({ path: testInfo.outputPath("editor-options-dragging.png"), style: "nextjs-portal { visibility: hidden; }" });
            await page.mouse.up();
            for (const preview of await page.locator("[data-editor-minimap]").all())
                await expect(preview).toHaveCSS("opacity", "1");
            await expect.poll(() => fixture.settings().cropX).not.toBe(0.5);
            await page.reload();
            await expect(background).toBeChecked();
            await expect(recursive).not.toBeChecked();
            await page.screenshot({ path: testInfo.outputPath("editor-options-restored.png"), style: "nextjs-portal { visibility: hidden; }" });
            await background.uncheck();
            await recursive.check();
            await expect.poll(() => fixture.settings().removeBackground).toBe(true);
            await expect.poll(() => fixture.settings().depth).toBe(5);
            const replacement = page.waitForEvent("filechooser");
            await page.getByRole("button", { name: "Upload another image" }).click();
            await (await replacement).setFiles({ name: "replacement.png", mimeType: "image/png", buffer: image });
            await expect(page.getByRole("img", { name: "Your uploaded photo" })).toBeVisible();
            await expect.poll(fixture.uploads).toBe(2);
            await page.getByRole("button", { name: "Confirm", exact: true }).click();
            await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
        }
        await expect(page.locator("html")).not.toHaveAttribute("data-camera-requested", "true");
        if (format === "png") {
            await page.route("**/api/design-drafts/2c22bf7e-e698-4a0a-90c4-66c5549f1c45", route => route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }));
            await page.route("**/api/configured-product-families", route => route.fulfill({ json: { products: [{
                            id: "4c22bf7e-e698-4a0a-90c4-66c5549f1c45", designId: protectedConfig("resource_83abf907850d"),
                            designRevisionId: "3c22bf7e-e698-4a0a-90c4-66c5549f1c45", baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
                            shopifyHandle: "bent-shirt", placement: { depth: 5, width: 0.22, x: 0.39, y: 0.43 },
                            projectionVersion: "safe-margin-v1", defaultColor: "White", createdAt: "2026-09-06T00:00:00Z",
                        }] } }));
            await page.route("**/api/configured-product-image/**", route => route.fulfill({ status: 202 }));
            await page.route("**/api/configured-product-lifestyle/**", route => route.fulfill({ status: 202 }));
            // A fresh product has no stored mockups and must reuse the editor's exact source.
            let previewSourceReads = 0;
            await page.route("**/api/product-preview/**", route => { if (route.request().url().includes("4c22bf7e"))
                previewSourceReads++; return route.fulfill({ status: 503 }); });
            const cpuRate = Number(process.env["E2E_PREVIEW_CPU_RATE"] ?? 1);
            if (cpuRate > 1)
                await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
            await page.evaluate(() => {
                document.addEventListener('click', event => {
                    if (event.target instanceof Element && event.target.closest('button')?.textContent === 'Continue')
                        document.documentElement.dataset['previewStart'] = String(performance.now());
                }, { capture: true });
                const observer = new MutationObserver(() => {
                    if (document.documentElement.dataset['previewStart'] && document.querySelector('canvas[data-preview-ready="true"]')) {
                        observer.disconnect();
                        requestAnimationFrame(() => requestAnimationFrame(() => {
                            document.documentElement.dataset['previewVisibleMs'] = String(performance.now() - Number(document.documentElement.dataset['previewStart']));
                        }));
                    }
                });
                observer.observe(document, { childList: true, subtree: true, attributes: true });
            });
            const continueAt = performance.now();
            await page.getByRole("button", { name: "Continue", exact: true }).click();
            await expect(page).toHaveURL(/\/product\/4c22bf7e-e698-4a0a-90c4-66c5549f1c45/);
            await expect(page.getByRole("combobox", { name: "Size", exact: true })).toBeVisible();
            const preview = page.getByRole("tabpanel", { name: "t-shirt", exact: true }).locator('canvas[data-preview-ready="true"]');
            await expect(preview).toBeVisible();
            const firstFlatMs = Math.round(performance.now() - continueAt);
            await expect(page.getByRole('button', { name: 'Show lifestyle image', exact: true })).toBeVisible();
            const lifestyleMs = Math.round(performance.now() - continueAt);
            expect(previewSourceReads).toBe(0);
            const paintedMs = await page.evaluate(() => Number(document.documentElement.dataset['previewVisibleMs']));
            console.info('Editor product handoff timing', JSON.stringify({ firstFlatMs, paintedMs, lifestyleMs, previewSourceReads, cpuRate }));
            await page.screenshot({ path: testInfo.outputPath("upload-product-mobile.png"), style: "nextjs-portal { visibility: hidden; }" });
        }
    });
}
test("invalid images stay on create and do not create a draft", async ({ page }) => {
    let draftRequests = 0;
    page.on("request", request => {
        if (request.url().endsWith("/api/design-drafts") && request.method() === "POST")
            draftRequests += 1;
    });
    await page.goto("/create");
    await expect(page.getByRole("img", { name: "QR code to continue creating this design on a phone", includeHidden: true })).toHaveCount(0);
    await page.getByRole("checkbox").check();
    for (const invalid of [
        { name: "image.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") },
        { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("broken") },
        { name: "large.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(20000000 + 1) },
    ]) {
        await page.locator('input[type="file"]').setInputFiles(invalid);
        await expect(page.locator("form").getByRole("alert")).toBeVisible();
        await expect(page).toHaveURL(/\/create$/);
        await expect(page.getByRole("button", { name: "Upload image", exact: true })).toBeEnabled();
    }
    expect(draftRequests).toBe(0);
});
test("failed uploads retry the retained image and missing handoffs allow reselection", async ({ page }) => {
    const fixture = await installCameraPreviewFixture(page, upload => Promise.resolve(upload === 1 ? "failure" : "success"));
    await page.goto("/design/" + protectedConfig("resource_83abf907850d") + "?upload=1");
    await expect(page.getByText("Choose an image to continue creating.")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(resolve("e2e/local/artwork.png"));
    await expect(page.getByRole("img", { name: "Your uploaded photo" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Your photo is still on this device" })).toBeVisible();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
    expect(fixture.uploads()).toBe(2);
    await expect(page.locator("html")).not.toHaveAttribute("data-camera-requested", "true");
});
test("pinching respects the shared print limit and Continue submits both products", async ({ page }, testInfo) => {
    const fixture = await installCameraPreviewFixture(page, () => Promise.resolve("success"), 1.524);
    await page.goto("/create");
    await page.getByRole("button", { name: "Upload image", exact: true }).click();
    await page.getByRole("checkbox").check();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload image", exact: true }).click();
    await (await chooser).setFiles(resolve("e2e/local/artwork.png"));
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    const canvas = page.locator("canvas.editor-direct-manipulation-cue");
    await expect(canvas).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await page.getByRole("checkbox", { name: "Effect", exact: true }).uncheck();
    const bounds = await canvas.boundingBox();
    if (!bounds)
        throw new Error("Expected the design canvas.");
    const session = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 20, y, id: 1 }, { x: x + 20, y, id: 2 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 90, y, id: 1 }, { x: x + 90, y, id: 2 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => fixture.settings().cropZoom).toBe(1.524);
    await page.reload();
    await expect(canvas).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("shared-print-limit-mobile.png"), style: "nextjs-portal { visibility: hidden; }" });
    let individualRequests = 0;
    await page.route("**/api/configured-products", route => { individualRequests++; return route.fulfill({ status: 500 }); });
    await page.route("**/api/configured-product-families", route => route.fulfill({ status: 422 }));
    const familyRequest = page.waitForRequest("**/api/configured-product-families");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    expect((await familyRequest).postDataJSON()).toMatchObject({ baseProductIds: [
            "a51b7acf-77e9-4762-83c4-62d96dd8942c",
            "97b629d7-1d3b-4d2a-a586-537168141e97",
        ] });
    await expect(page.getByRole("alert").filter({ hasText: "Zoom out or use a higher-resolution photo" })).toBeVisible();
    expect(individualRequests).toBe(0);
    expect(fixture.settings().cropZoom).toBe(1.524);
    await expect(page).toHaveURL(/\/design\//);
});
test("48 MP uploads above 8 MB reach the editor with every source byte retained", async ({ page }) => {
    await installCameraPreviewFixture(page, () => Promise.resolve("success"));
    const photo = await sharp({ create: { width: 8064, height: 6048, channels: 3, background: "#73614a" } }).jpeg().toBuffer();
    // Legal trailing padding exercises the byte boundary without a huge fixture.
    const image = Buffer.concat([photo, Buffer.alloc(9000000 - photo.length)]);
    await page.goto("/create");
    await page.getByRole("checkbox").check();
    const uploadRequest = page.waitForRequest("**/fixture-upload");
    await page.locator('input[type="file"]').setInputFiles({ name: "48mp.jpg", mimeType: "image/jpeg", buffer: image });
    const bytes = (await uploadRequest).postDataBuffer();
    expect(bytes?.equals(image)).toBe(true);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
});
test("upload preserves a declaration accepted before mobile hydration", async ({ page }) => {
    const fixture = await installCameraPreviewFixture(page, () => Promise.resolve("success"), 2.6, true);
    const scripts = Promise.withResolvers<void>();
    // Keep the server-rendered form usable while its client scripts are in flight.
    // Only scripts are held, so styles and the native checkbox still work.
    await page.route("**/_next/static/chunks/**", async route => {
        if (route.request().resourceType() === "script") await scripts.promise;
        await route.continue();
    });
    await page.goto("/create", { waitUntil: "commit" });
    try {
        await page.getByRole("checkbox").check();
    } finally {
        scripts.resolve();
    }
    await page.waitForLoadState("load");
    await expect(page.getByRole("img", { name: "QR code to continue creating this design on a phone", includeHidden: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toBeChecked();
    await page.locator('input[type="file"]').setInputFiles(resolve("e2e/local/artwork.png"));
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    expect(fixture.sourceBytes()?.equals(await readFile(resolve("e2e/local/artwork.png")))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.dataset["cameraRequested"])).toBeUndefined();
});
test("progressive upload keeps edits through refresh and print completion", async ({ page }, testInfo) => {
    const fixture = await installCameraPreviewFixture(page, () => Promise.resolve("success"), 2.6, true);
    await page.goto("/create");
    await page.getByRole("checkbox").check();
    await page.locator('input[type="file"]').setInputFiles(resolve("e2e/local/artwork.png"));
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    const canvas = page.locator("canvas.editor-direct-manipulation-cue");
    await expect(canvas).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await expect(page.getByText("Preparing print-quality photo…", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Effect", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "Background", exact: true }).check();
    await expect.poll(() => fixture.settings().depth).toBe(0);
    await expect.poll(() => fixture.settings().removeBackground).toBe(false);
    const saved = { ...fixture.settings() };
    await page.reload();
    await expect(canvas).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Background", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Effect", exact: true })).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    // Reopening a pending camera draft must restore its canvas without requesting
    // camera access again. Removing upload=1 exercises that recovery route too.
    await page.goto(new URL(page.url()).pathname);
    await expect(canvas).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset["cameraRequested"])).toBeUndefined();
    await page.screenshot({ path: testInfo.outputPath("progressive-editing.png"), style: "nextjs-portal { visibility: hidden; }" });
    fixture.fail();
    await expect(page.getByText("Photo preparation failed. Your edits are saved.")).toBeVisible();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByText("Preparing print-quality photo…", { exact: true })).toBeVisible();
    const pendingBounds = await canvas.boundingBox();
    fixture.finish();
    await expect(page.getByText("Preparing print-quality photo…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    expect(fixture.settings()).toEqual(saved);
    expect(await canvas.boundingBox()).toEqual(pendingBounds);
    await expect.poll(() => canvas.evaluate(element => {
        if (!(element instanceof HTMLCanvasElement))
            return false;
        const context = element.getContext("2d");
        return context ? context.getImageData(0, 0, element.width, element.height).data.some(value => value !== 0) : false;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("progressive-print-ready.png"), style: "nextjs-portal { visibility: hidden; }" });
});
test("new photo auto-composes instead of copying the previous photo settings", async ({ page }, testInfo) => {
    const fixture = await installCameraPreviewFixture(page, () => Promise.resolve("success"));
    const image = await sharp(resolve("e2e/local/artwork.png")).resize({ width: 5000 }).webp().toBuffer();
    const background = page.getByRole("checkbox", { name: "Background", exact: true });
    const effect = page.getByRole("checkbox", { name: "Effect", exact: true });
    await page.goto("/create");
    await page.getByRole("checkbox").check();
    await page.locator('input[type="file"]').setInputFiles({ name: "first.webp", mimeType: "image/webp", buffer: image });
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
    await expect(background).not.toBeChecked();
    await expect(effect).toBeChecked();
    await expect.poll(() => fixture.settings().removeBackground).toBe(true);
    const composed = { ...fixture.settings() };
    await page.screenshot({ path: testInfo.outputPath("initial-composition-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
    await background.check();
    await effect.uncheck();
    const canvas = await page.locator("canvas.editor-direct-manipulation-cue").boundingBox();
    if (!canvas)
        throw new Error("Canvas missing");
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width / 2 + 20, canvas.y + canvas.height / 2 + 20);
    await page.mouse.up();
    await expect.poll(() => fixture.settings().cropX).not.toBe(composed.cropX);
    await expect.poll(() => fixture.settings().removeBackground).toBe(false);
    await expect.poll(() => fixture.settings().depth).toBe(0);
    const previous = { ...fixture.settings() };
    await page.reload();
    await expect(background).toBeChecked();
    await expect(effect).not.toBeChecked();
    const replacement = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload another image" }).click();
    // Even identical bytes selected deliberately are a new photo operation.
    await (await replacement).setFiles({ name: "replacement.webp", mimeType: "image/webp", buffer: image });
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
    await expect(background).not.toBeChecked();
    await expect(effect).toBeChecked();
    await expect.poll(() => fixture.settings()).toEqual(composed);
    expect(fixture.settings()).not.toEqual(previous);
    await page.reload();
    await expect(background).not.toBeChecked();
    await expect(effect).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("replacement-composition-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
    console.info("New photo settings", JSON.stringify({ composed, previous, replacement: fixture.settings() }));
});
for (const recovery of ["success", "failure", "pending", "rejected"]) {
    test(`aged clearance ${recovery} preserves the same draft and retained source through Try again`, async ({ page }, testInfo) => {
        const fixture = await installCameraPreviewFixture(page, () => Promise.resolve("success"), 2.6, false, true);
        let proofs = 0;
        page.on("request", request => { if (request.headers()["x-turnstile-token"])
            proofs++; });
        // Age only the browser lifetime of the legitimate, server-signed fixture
        // clearance. No customer cookies or production credentials are used.
        await page.route("**/api/design-drafts", async (route) => {
            if (route.request().method() !== "POST")
                return route.fallback();
            const response = await route.fetch();
            const headers = response.headers();
            headers["set-cookie"] = (headers["set-cookie"] ?? "").replace("Max-Age=900", "Max-Age=1");
            await route.fulfill({ response, headers });
        });
        const image = await sharp(resolve("e2e/local/artwork.png")).resize({ width: 5000 }).webp().toBuffer();
        await page.goto("/create");
        await page.screenshot({ path: testInfo.outputPath("challenge-create-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
        await page.getByRole("checkbox").check();
        // Hold the source handoff until its initial clearance has expired naturally.
        await page.route("**/api/design-drafts/*/upload-grants", async (route) => {
            await expect.poll(async () => (await page.context().cookies()).some(cookie => cookie.name === "__Host-forever_tee_abuse"), { timeout: 5000 }).toBe(false);
            if (!route.request().headers()["x-turnstile-token"])
                return route.fallback();
            const response = await route.fetch();
            const headers = response.headers();
            headers["set-cookie"] = (headers["set-cookie"] ?? "").replace("Max-Age=900", "Max-Age=1");
            await route.fulfill({ response, headers });
        });
        await page.locator('input[type="file"]').setInputFiles({ name: "source.webp", mimeType: "image/webp", buffer: image });
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "Your photo is still on this device" })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("challenge-error-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
        const draftUrl = page.url();
        expect(fixture.uploads()).toBe(0);
        await page.evaluate(outcome => { document.documentElement.dataset["fixtureProof"] = outcome; }, recovery);
        const grantStatuses: number[] = [];
        page.on("response", response => { if (response.url().endsWith("/upload-grants"))
            grantStatuses.push(response.status()); });
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        if (recovery === "pending" || recovery === "failure") {
            await expect(page.getByLabel("Security check")).toBeAttached();
            if (recovery === "failure") {
                await expect(page.getByText("The security check failed. Please try it again.")).toBeVisible();
                await page.getByRole("button", { name: "Retry security check" }).click({ trial: true });
            }
            expect(fixture.uploads()).toBe(0);
            expect(grantStatuses).toEqual([]);
            expect(page.url()).toBe(draftUrl);
            await page.screenshot({ path: testInfo.outputPath("challenge-proof-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
            await page.getByRole("link", { name: "create", exact: true }).click();
            await expect(page).toHaveURL(/\/create$/);
            await page.evaluate(() => { document.dispatchEvent(new Event("fixture-proof")); });
            expect(fixture.uploads()).toBe(0);
            expect(grantStatuses).toEqual([]);
            return;
        }
        if (recovery === "rejected") {
            await expect(page.getByRole("alert").filter({ hasText: "Your photo is still on this device" })).toBeVisible();
            await expect.poll(() => grantStatuses.length).toBe(1);
            expect(grantStatuses).toEqual([403]);
            expect(fixture.uploads()).toBe(0);
            expect(page.url()).toBe(draftUrl);
            await page.evaluate(() => { document.documentElement.dataset["fixtureProof"] = "success"; });
            await page.getByRole("button", { name: "Try again", exact: true }).click();
        }
        await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
        expect(page.url()).toBe(draftUrl);
        await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
        expect(fixture.sourceBytes()?.equals(image)).toBe(true);
        expect(proofs).toBe(recovery === "rejected" ? 3 : 2);
        expect(fixture.uploads()).toBe(1);
        await page.screenshot({ path: testInfo.outputPath("challenge-recovered-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
        if (recovery === "success") {
            await expect.poll(() => fixture.settings().removeBackground).toBe(true);
            const composed = { ...fixture.settings() };
            await page.getByRole("checkbox", { name: "Background", exact: true }).check();
            await page.getByRole("checkbox", { name: "Effect", exact: true }).uncheck();
            await expect.poll(() => fixture.settings().removeBackground).toBe(false);
            await expect.poll(() => fixture.settings().depth).toBe(0);
            const saved = { ...fixture.settings() };
            const writesBeforeReplacement = fixture.settingsWrites.length;
            await page.reload();
            await expect(page.getByRole("checkbox", { name: "Background", exact: true })).toBeChecked();
            await expect(page.getByRole("checkbox", { name: "Effect", exact: true })).not.toBeChecked();
            const replacement = page.waitForEvent("filechooser");
            await page.getByRole("button", { name: "Upload another image" }).click();
            await (await replacement).setFiles({ name: "source.webp", mimeType: "image/webp", buffer: image });
            await page.getByRole("button", { name: "Confirm", exact: true }).click();
            await expect(page.getByRole("alert").filter({ hasText: "Your photo is still on this device" })).toBeVisible();
            expect(fixture.settings()).toEqual(saved);
            expect(fixture.settingsWrites).toHaveLength(writesBeforeReplacement);
            await page.evaluate(() => { document.documentElement.dataset["fixtureProof"] = "failure"; });
            await page.getByRole("button", { name: "Try again", exact: true }).click();
            await expect(page.getByText("The security check failed. Please try it again.")).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath("replacement-proof-failure-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
            // Wait beyond the 180 ms debounce to catch an unintended pending save.
            await page.waitForTimeout(400);
            expect(fixture.settings()).toEqual(saved);
            expect(fixture.settingsWrites).toHaveLength(writesBeforeReplacement);
            expect(fixture.uploads()).toBe(1);
            expect(page.url()).toBe(draftUrl);
            await page.evaluate(() => { document.documentElement.dataset["fixtureProof"] = "success"; });
            await page.getByRole("button", { name: "Retry security check" }).click();
            await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
            expect(page.url()).toBe(draftUrl);
            expect(fixture.sourceBytes()?.equals(image)).toBe(true);
            expect(fixture.uploads()).toBe(2);
            // This is the first completed composition of the newly selected photo.
            // Prior-photo settings remain saved during proof failure, then the new
            // photo gets the same automatic composition as an unchallenged upload.
            const background = page.getByRole("checkbox", { name: "Background", exact: true });
            const effect = page.getByRole("checkbox", { name: "Effect", exact: true });
            await expect(background).not.toBeChecked();
            await expect(effect).toBeChecked();
            await expect.poll(() => fixture.settingsWrites.length).toBeGreaterThan(writesBeforeReplacement);
            await expect.poll(() => fixture.settings()).toEqual(composed);
            await page.reload();
            await expect(background).not.toBeChecked();
            await expect(effect).toBeChecked();
            await page.screenshot({ path: testInfo.outputPath("replacement-recovered-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
            // Choices made on this completed photo survive the settled save and refresh.
            await background.check();
            await effect.uncheck();
            await expect.poll(() => fixture.settings().removeBackground).toBe(false);
            await expect.poll(() => fixture.settings().depth).toBe(0);
            const recoveredChoices = { ...fixture.settings() };
            await page.reload();
            await expect(background).toBeChecked();
            await expect(effect).not.toBeChecked();
            expect(fixture.settings()).toEqual(recoveredChoices);
            await page.screenshot({ path: testInfo.outputPath("replacement-choices-restored-phone.png"), style: "nextjs-portal { visibility: hidden; }" });
            console.info("Recovered photo settings", JSON.stringify({ composed, previous: saved, recovered: recoveredChoices }));
        }
    });
}
