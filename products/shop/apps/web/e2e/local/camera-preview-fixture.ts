import { protectedConfig } from "../../../../scripts/protected-config.mjs";
import { Schema } from "effect";
import { DesignSettingsMutationSchema, type EditorSettingsDto } from "@forever-tee/contracts";
import type { Page } from "@playwright/test";
import { resolve } from "node:path";
import sharp from "sharp";
export async function installCameraPreviewFixture(page: Page, processUpload: (upload: number) => Promise<"success" | "failure">, maximumCropZoom = 2.6, progressive = false, realChallengeBoundary = false) {
    const id = protectedConfig("resource_83abf907850d");
    const preview = await sharp(resolve("e2e/local/artwork.png")).webp().toBuffer();
    const original = await sharp(resolve("e2e/local/artwork.png")).flatten({ background: "#bee0f5" }).webp().toBuffer();
    let settings: EditorSettingsDto = { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.3, placementY: 0.3, placementWidth: 0.2, depth: 5 };
    const settingsWrites: EditorSettingsDto[] = [];
    let version = 0;
    let uploads = 0;
    let sourceBytes: Buffer | null = null;
    let ready = false;
    let failed = false;
    let finalized = false;
    const artworkJobId = "aca00464-4d7c-4588-9871-6ca71dcd223c";
    const finalPreview = await sharp(resolve("e2e/local/artwork.png")).resize({ width: 1600 }).webp().toBuffer();
    const traces: string[] = [];
    await page.addInitScript(() => {
        let attempt = 0;
        let retryProof: (() => void) | undefined;
        window.turnstile = {
            render(_container, options) {
                attempt++;
                const token = `local-token-${String(attempt)}`;
                const complete = () => {
                    const outcome = document.documentElement.dataset["fixtureProof"];
                    if (outcome === "failure")
                        options["error-callback"]();
                    else if (outcome === "pending")
                        document.addEventListener("fixture-proof", () => options.callback(token), { once: true });
                    else
                        options.callback(outcome === "rejected" ? "fixture-rejected-token" : token);
                };
                retryProof = complete;
                queueMicrotask(complete);
                return "local-widget";
            },
            remove() { retryProof = undefined; },
            reset() { if (retryProof)
                queueMicrotask(retryProof); },
        };
    });
    await page.route("**/api/design-drafts**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (realChallengeBoundary && (path === "/api/design-drafts" && request.method() === "POST" || path.endsWith("/upload-grants")))
            return route.fallback();
        if (path === "/api/design-drafts") {
            return route.fulfill({ json: request.method() === "POST" ? { id, version } : { items: [], nextCursor: null } });
        }
        if (path === `/api/design-drafts/${id}/artwork-sources/original` || path === `/api/design-drafts/${id}/artwork-sources/cutout`) {
            return route.fulfill({ contentType: "image/webp", body: path.endsWith("/original") ? original : progressive && ready ? finalPreview : preview });
        }
        if (path.endsWith("/artwork-processing")) {
            failed = false;
            return route.fulfill({ status: 202, json: { id } });
        }
        if (path.endsWith("/upload-grants")) {
            return route.fulfill({ json: { uploadUrl: "http://localhost:4317/fixture-upload", expiresAt: "2099-01-01T00:00:00Z" } });
        }
        if (path === `/api/design-drafts/${id}` && request.method() === "GET") {
            return route.fulfill({ json: {
                    ...(progressive && uploads > 0 ? { previewReady: true, artworkJobId, artworkProcessingStatus: failed ? "failed" : ready ? "complete" : "pending" } : {}),
                    id, version, finalized, status: ready ? "ready" : "creating", contentType: "image/png",
                    artworkRevision: ready ? "a".repeat(64) : null, artworkUrl: "/fixture/artwork",
                    createdAt: "2026-09-06T00:00:00Z", updatedAt: `2026-09-06T00:00:${String(version).padStart(2, "0")}Z`,
                    settings, maximumCropZoom: ready || (progressive && uploads > 0) ? maximumCropZoom : null, hasOriginalArtwork: ready || (progressive && uploads > 0), defaultColor: "White", defaultColorStatus: "complete",
                } });
        }
        if (path === `/api/design-drafts/${id}` && request.method() === "PATCH") {
            settings = Schema.decodeUnknownSync(DesignSettingsMutationSchema)(request.postDataJSON()).settings;
            settingsWrites.push({ ...settings });
            version += 1;
            return route.fulfill({ json: { id, version, updatedAt: `2026-09-06T00:00:${String(version).padStart(2, "0")}Z` } });
        }
        throw new Error(`Unexpected camera fixture request: ${request.method()} ${path}`);
    });
    await page.route("**/fixture-upload", async (route) => {
        uploads += 1;
        sourceBytes = route.request().postDataBuffer();
        ready = false;
        if (await processUpload(uploads) === "failure") {
            return route.fulfill({ status: 400, json: { error: { code: "BAD_REQUEST", message: "Fixture upload failed." } } });
        }
        ready = !progressive;
        version += 1;
        return route.fulfill({ status: progressive ? 202 : 200, json: {
                ...(progressive ? { printReady: false, artworkJobId } : {}),
                id, version, artworkUrl: "/fixture/artwork", updatedAt: `2026-09-06T00:00:${String(version).padStart(2, "0")}Z`,
                preview: { contentType: "image/webp", base64: preview.toString("base64") },
            } });
    });
    await page.route(`**/v1/designs/${id}/artwork/preview?**`, route => route.fulfill({
        contentType: "image/webp", body: settings.removeBackground === false ? original : preview,
    }));
    await page.route("**/api/configured-product-families", route => {
        finalized = true;
        return route.fulfill({ status: 201, json: { products: [
                    { id: "6c22bf7e-e698-4a0a-90c4-66c5549f1c45", baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c", shopifyHandle: "bent-shirt" },
                    { id: "7c22bf7e-e698-4a0a-90c4-66c5549f1c45", baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97", shopifyHandle: "cotton-tote" },
                ].map(record => ({ ...record, designId: id, designRevisionId: null, preparationId: id,
                    placement: { depth: settings.depth, width: 0.22, x: 0.39, y: 0.43 }, projectionVersion: "safe-margin-v1",
                    defaultColor: "White", createdAt: "2026-09-06T00:00:00Z" })) } });
    });
    await page.route("**/api/product-availability", route => route.fulfill({ json: { available: true } }));
    await page.route("**/api/creation-trace", route => {
        traces.push(route.request().postData() ?? "");
        return route.fulfill({ status: 204 });
    });
    return { sourceBytes: () => sourceBytes, uploads: () => uploads, settings: () => settings, settingsWrites, traces,
        finish: () => { ready = true; version += 1; }, fail: () => { failed = true; } };
}
// Real video frames with deterministic front/rear discovery and phone-style
// exclusive access. This exercises the production camera journey in Chromium.
export async function installCameraDevicesFixture(page: Page, cameraCount = 2, discoveryFails = false) {
    await page.addInitScript(({ cameraCount, discoveryFails }) => {
        const media = navigator.mediaDevices;
        const getUserMedia = media.getUserMedia.bind(media);
        let active: MediaStream | undefined;
        media.enumerateDevices = async () => {
            if (discoveryFails)
                throw new Error("Device discovery unavailable.");
            const count = document.documentElement.dataset["cameraCount"];
            return Array.from({ length: count === undefined ? cameraCount : Number(count) }, (_, index) => ({
                deviceId: index === 0 ? "front" : "rear", groupId: "phone", kind: "videoinput",
                label: index === 0 ? "Front camera" : "Back camera", toJSON() { return {}; },
            }));
        };
        media.getUserMedia = async (constraints) => {
            if (active?.getTracks().some(track => track.readyState === "live")) {
                throw new Error("Previous camera must be stopped before switching.");
            }
            const video = constraints?.video;
            const facingMode = typeof video === "object" ? video.facingMode : undefined;
            const deviceId = typeof video === "object" ? video.deviceId : undefined;
            const facing = typeof facingMode === "string" ? facingMode :
                typeof facingMode === "object" && !Array.isArray(facingMode) ? facingMode.exact ?? facingMode.ideal : undefined;
            const facingName = deviceId && typeof deviceId === "object" && !Array.isArray(deviceId) && deviceId.exact === "front"
                ? "user" : facing === "environment" ? "environment" : "user";
            const state = document.documentElement.dataset;
            state["cameraRequests"] = `${state["cameraRequests"] ?? ""}${facingName},`;
            if (facingName === "environment" && state["failCameraFlip"] === "true") {
                throw new DOMException("Rear camera unavailable.", "NotReadableError");
            }
            if (facingName === "environment" && state["holdCameraFlip"] === "true") {
                await new Promise<void>(resolve => {
                    const interval = setInterval(() => {
                        if (state["holdCameraFlip"] !== "true") {
                            clearInterval(interval);
                            resolve();
                        }
                    }, 25);
                });
            }
            // Synthetic hardware identities must not be passed to Chromium's one fake camera.
            active = await getUserMedia({ audio: false, video: { width: { ideal: 3840 } } });
            const selectedFacing = facingName === "environment" && state["ignoreCameraFacing"] === "true" ? "user" : facingName;
            for (const track of active.getVideoTracks()) {
                const stop = track.stop.bind(track);
                track.stop = () => {
                    if (track.readyState === "live")
                        state["cameraStops"] = String(Number(state["cameraStops"] ?? "0") + 1);
                    stop();
                };
                const getSettings = track.getSettings.bind(track);
                track.getSettings = () => ({ ...getSettings(), facingMode: selectedFacing, deviceId: selectedFacing === "user" ? "front" : "rear" });
            }
            state["cameraFacing"] = selectedFacing;
            return active;
        };
        const scale = CanvasRenderingContext2D.prototype.scale;
        CanvasRenderingContext2D.prototype.scale = function (x, y) {
            if (x === -1)
                document.documentElement.dataset["mirroredCapture"] = "true";
            scale.call(this, x, y);
        };
    }, { cameraCount, discoveryFails });
}
