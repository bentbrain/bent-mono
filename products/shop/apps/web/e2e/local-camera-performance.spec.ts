import { protectedConfig } from "../../../scripts/protected-config.mjs";
import { expect, test } from "./test";
// Match Next dev's normalized loopback origin for its real declaration handler.
test.use({ baseURL: "http://localhost:4317" });
declare global {
    interface Window {
        cameraPerformance: {
            opens: number;
            streams: MediaStream[];
        };
    }
}
// Fixed camera startup and BFF latency isolate route/stream handoff overhead.
// No real camera, portrait, challenge, upload or provider request is used.
test("camera handoff opens one stream and releases it on navigation", async ({ page }) => {
    test.setTimeout(90000);
    const id = protectedConfig("resource_83abf907850d");
    let reads = 0;
    await page.addInitScript(() => {
        window.cameraPerformance = { opens: 0, streams: [] };
        navigator.mediaDevices.getUserMedia = async () => {
            window.cameraPerformance.opens += 1;
            await new Promise(resolve => setTimeout(resolve, 200));
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 480;
            canvas.getContext("2d")?.fillRect(0, 0, 640, 480);
            const stream = canvas.captureStream(15);
            window.cameraPerformance.streams.push(stream);
            return stream;
        };
        window.turnstile = {
            render(_container, options) { queueMicrotask(() => options.callback("local-token")); return "local-widget"; },
            remove() { }, reset() { },
        };
    });
    await page.route("**/api/design-drafts**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === "/api/design-drafts") {
            return route.fulfill({ json: request.method() === "POST" ? { id, version: 0 } : { items: [], nextCursor: null } });
        }
        if (path === `/api/design-drafts/${id}` && request.method() === "GET") {
            reads += 1;
            await new Promise(resolve => setTimeout(resolve, 100));
            return route.fulfill({ json: {
                    id, version: 0, finalized: false, status: "creating", contentType: "image/png", artworkRevision: null,
                    artworkUrl: "/fixture/artwork", createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z",
                    settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.3, placementY: 0.3, placementWidth: 0.2, depth: 5 },
                } });
        }
        throw new Error(`Unexpected draft fixture request: ${request.method()} ${path}`);
    });
    await page.route("**/api/product-availability", route => route.fulfill({ json: { available: true } }));
    const measurements = [];
    await page.goto("/create");
    // One cold entry and one client-side return cover stream ownership without
    // repeating five fresh-document latency samples in every regression run.
    for (let sample = 0; sample < 2; sample += 1) {
        await expect(page.getByRole("status").filter({ hasText: "Loading designs" })).toHaveCount(0);
        await expect(page.getByRole("alert").filter({ hasText: "Your saved designs couldn't be loaded." })).toHaveCount(0);
        await page.getByRole("checkbox").check();
        const start = performance.now();
        await page.getByRole("button", { name: "Open camera", exact: true }).click();
        await page.waitForFunction(() => {
            const capture = document.querySelector('button[aria-label="Take photo in 3 seconds"]');
            return capture instanceof HTMLButtonElement && !capture.disabled;
        }, undefined, { timeout: 15000, polling: "raf" });
        const readyMs = Math.round(performance.now() - start);
        const opens = await page.evaluate(() => window.cameraPerformance.opens);
        measurements.push({ readyMs, opens });
        await page.getByRole("link", { name: "create", exact: true }).click();
        await expect(page).toHaveURL(/\/create$/);
        await expect.poll(() => page.evaluate(() => window.cameraPerformance.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    }
    console.info("Camera handoff benchmark", JSON.stringify({ measurements, reads, cameraDelayMs: 200, draftReadDelayMs: 100 }));
    expect(measurements.map(sample => sample.opens)).toEqual([1, 2]);
    expect(reads).toBe(2);
});
