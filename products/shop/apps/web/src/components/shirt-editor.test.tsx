// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ParseResult, Schema } from "effect";
import { act, Suspense, use, useState, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShirtEditor } from "@/components/shirt-editor";
import type { CreationTraceEvent } from "@/client/creation-trace";
import { DEFAULT_SETTINGS } from "@/lib/recursive-image";
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "fixture-key" } }));
const mocks = vi.hoisted(() => ({
    createConfiguredProductFamily: vi.fn(),
    getArtworkSourcePreview: vi.fn<(id: string, kind: "original" | "cutout") => Promise<Blob>>(),
    getArtworkPreview: vi.fn<(id: string, revision?: string) => Promise<Blob>>(),
    processDesignArtwork: vi.fn<(id: string, image: Blob) => Promise<{
        artworkUrl: string;
        preview?: Blob;
        id: string;
        updatedAt: string;
        version: number;
        diagnostics?: {
            durationMs: number;
            requestId: string | undefined;
        };
    }>>(),
    reportCreationTrace: vi.fn<(event: CreationTraceEvent) => void>(),
    removeBackground: vi.fn<(image: Blob) => Promise<Blob>>(),
    renderRecursiveImage: vi.fn(),
    routerReplace: vi.fn(),
    updateDesignSettings: vi.fn(),
}));
vi.mock("@/client/design-api", () => ({
    getArtworkPreview: (id: string, revision?: string) => mocks.getArtworkPreview(id, revision),
    getArtworkSourcePreview: mocks.getArtworkSourcePreview,
    getDesign: vi.fn(),
    retryArtworkPreparation: vi.fn(),
    processDesignArtwork: (id: string, image: Blob) => mocks.processDesignArtwork(id, image),
    removeBackground: (image: Blob) => mocks.removeBackground(image),
    updateDesignSettings: mocks.updateDesignSettings,
}));
vi.mock("@/client/creation-trace", () => ({
    reportCreationTrace: mocks.reportCreationTrace,
}));
vi.mock("@/client/product-api", () => ({
    createConfiguredProductFamily: mocks.createConfiguredProductFamily,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: mocks.routerReplace }),
}));
vi.mock("@/lib/recursive-image", () => ({
    DEFAULT_SETTINGS: {
        cropX: 0.5,
        cropY: 0.5,
        cropZoom: 1,
        depth: 5,
        placementWidth: 0.22,
        placementX: 0.39,
        placementY: 0.43,
    },
    PREVIEW_HEIGHT: 1200,
    PREVIEW_WIDTH: 1000,
    canvasToBlob: (canvas: HTMLCanvasElement, options: {
        quality: number;
        type: string;
    }) => new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob)
                resolve(blob);
            else
                reject(new Error("Canvas encoding failed."));
        }, options.type, options.quality);
    }),
    clamp: (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value)),
    renderRecursiveImage: mocks.renderRecursiveImage,
    suggestSettings: vi.fn(() => ({
        cropX: 0.5,
        cropY: 0.5,
        cropZoom: 1,
        depth: 5,
        placementWidth: 0.22,
        placementX: 0.39,
        placementY: 0.43,
    })),
}));
vi.mock("@/components/editor-minimap", () => ({
    EditorMinimap: ({ canvasRef, }: {
        canvasRef: RefObject<HTMLCanvasElement | null>;
    }) => <canvas ref={canvasRef} data-editor-minimap=""/>,
}));
vi.mock("@/components/processed-cutout-reveal", () => ({
    ProcessedCutoutReveal: ({ onCovered, onComplete }: {
        onCovered: () => void;
        onComplete: () => void;
    }) => (<button data-complete-cutout-reveal="" onClick={() => { onCovered(); onComplete(); }}/>),
}));
vi.mock("@/components/processing-piercing-loader", () => ({
    ProcessingPiercingLoader: () => <div data-processing-loader=""/>,
}));
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.replaceChildren();
});
describe("progressive artwork", () => {
    it("allows Continue from an editable preview while final artwork decodes", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const early = { width: 768, height: 1024, close: vi.fn() };
        const final = { width: 1200, height: 1600, close: vi.fn() };
        const decode = Promise.withResolvers<typeof final>();
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValueOnce(early).mockImplementation(() => decode.promise));
        mocks.getArtworkSourcePreview.mockResolvedValue(new Blob(["preview"]));
        mocks.updateDesignSettings.mockResolvedValue({ updatedAt: "edit-2", version: 2 });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
        const render = (ready: boolean) => {
            root.render(<QueryClientProvider client={client}>
      <ShirtEditor initialDesign={{ id: "design-1", artworkJobId: "job-1", previewReady: true,
                    artworkProcessingStatus: ready ? "complete" : "pending", status: ready ? "ready" : "creating",
                    hasOriginalArtwork: true, maximumCropZoom: 2,
                    settings: { ...DEFAULT_SETTINGS, cropX: 0.3, depth: 2 }, updatedAt: ready ? "final" : "early" }}/>
    </QueryClientProvider>);
        };
        await act(async () => { render(false); await vi.advanceTimersByTimeAsync(200); });
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        const continueButton = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Continue");
        expect(continueButton()?.disabled).toBe(false);
        const effect = [...container.querySelectorAll("label")].find(label => label.textContent.includes("Effect"))?.querySelector("input");
        if (!effect)
            throw new Error("Expected effect control");
        await act(async () => { effect.click(); await vi.advanceTimersByTimeAsync(250); });
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        expect(mocks.updateDesignSettings).toHaveBeenCalledWith("design-1", expect.objectContaining({ cropX: 0.3, depth: 0 }));
        await act(async () => { render(true); await vi.advanceTimersByTimeAsync(250); });
        expect(continueButton()?.disabled).toBe(false);
        await act(async () => { decode.resolve(final); await vi.advanceTimersByTimeAsync(250); });
        expect(continueButton()?.disabled).toBe(false);
        expect(mocks.renderRecursiveImage).toHaveBeenCalledWith(expect.anything(), final, expect.objectContaining({ cropX: 0.3, depth: 0 }));
        expect(early.close).toHaveBeenCalledOnce();
        act(() => { root.unmount(); });
        client.clear();
    });
});
describe("ShirtEditor artwork preparation", () => {
    it.each([1.524, 0.4, null])("uses the server print limit when reopening a zoomed draft: %s", async (maximumCropZoom) => {
        vi.useFakeTimers();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        // This is a downscaled preview; its dimensions must not determine print quality.
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 600, height: 800, close: vi.fn() }));
        mocks.getArtworkPreview.mockResolvedValue(new Blob(["preview"]));
        mocks.updateDesignSettings.mockResolvedValue({ updatedAt: "revision-2", version: 2 });
        mocks.createConfiguredProductFamily.mockReset().mockResolvedValue([{ id: "shirt-1" }, { id: "tote-1" }]);
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
        await act(async () => {
            root.render(<QueryClientProvider client={queryClient}>
        <ShirtEditor initialDesign={{ id: "design-1", status: "ready", maximumCropZoom,
                    settings: { ...DEFAULT_SETTINGS, cropZoom: 2.4766 }, updatedAt: "revision-1" }}/>
      </QueryClientProvider>);
            await vi.advanceTimersByTimeAsync(200);
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Continue");
        if (!button)
            throw new Error("Expected Continue");
        if (maximumCropZoom === 1.524) {
            expect(mocks.updateDesignSettings).toHaveBeenCalledWith("design-1", expect.objectContaining({ cropZoom: 1.524 }));
            expect(button.disabled).toBe(false);
            await act(async () => { button.click(); await vi.advanceTimersByTimeAsync(200); });
            expect(mocks.createConfiguredProductFamily).toHaveBeenCalledOnce();
            expect(mocks.routerReplace).toHaveBeenCalledWith("/product/shirt-1");
        }
        else {
            expect(button.disabled).toBe(true);
            expect(mocks.createConfiguredProductFamily).not.toHaveBeenCalled();
            expect(container.textContent).toContain(maximumCropZoom === null ? "Checking print quality" : "higher-resolution photo");
        }
        act(() => { root.unmount(); });
        queryClient.clear();
    });
    it.each(["cancel", "replace", "retry", "parse-error", "syntax-error", "confirm-ready", "discard-decoding"])("retakes a photo without a blank or stale canvas: %s", async (outcome) => {
        mocks.processDesignArtwork.mockReset();
        vi.useFakeTimers();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const original = { close: vi.fn(), height: 1000, width: 1000 };
        const replacement = { close: vi.fn(), height: 1000, width: 1000 };
        const decode = Promise.withResolvers<typeof replacement>();
        vi.stubGlobal("createImageBitmap", vi.fn()
            .mockResolvedValueOnce(original)
            .mockImplementation(() => outcome === "discard-decoding" ? decode.promise : Promise.resolve(replacement)));
        vi.stubGlobal("URL", class extends URL {
            static override createObjectURL = vi.fn(() => "blob:test");
            static override revokeObjectURL = vi.fn();
        });
        Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
        const track = {
            getSettings: () => ({ facingMode: "user", deviceId: "front" }),
            applyConstraints: vi.fn().mockResolvedValue(undefined),
            getCapabilities: () => ({}), stop: vi.fn(),
        };
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { addEventListener: vi.fn(), removeEventListener: vi.fn(), getUserMedia: vi.fn().mockResolvedValue({
                    getTracks: () => [track], getVideoTracks: () => [track],
                }) },
        });
        Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
            configurable: true, writable: true, value: null,
        });
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
            configurable: true,
            value: () => ({ drawImage: vi.fn(), scale: vi.fn(), translate: vi.fn() }),
        });
        HTMLCanvasElement.prototype.toBlob = (callback) => {
            callback(new Blob(["new photo"], { type: "image/jpeg" }));
        };
        mocks.getArtworkPreview.mockResolvedValue(new Blob(["original"]));
        mocks.updateDesignSettings.mockResolvedValue({ updatedAt: "revision-2", version: 2 });
        const upload = Promise.withResolvers<Awaited<ReturnType<typeof mocks.processDesignArtwork>>>();
        mocks.processDesignArtwork.mockImplementation(() => upload.promise);
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
        const settle = async () => { await vi.advanceTimersByTimeAsync(200); };
        const click = async (selector: string) => {
            const button = container.querySelector<HTMLButtonElement>(selector);
            if (!button)
                throw new Error(`Missing button: ${selector}`);
            await act(async () => { button.click(); await settle(); });
        };
        await act(async () => {
            root.render(<QueryClientProvider client={queryClient}>
        <ShirtEditor initialDesign={{ id: "design-1", status: "ready", settings: DEFAULT_SETTINGS, updatedAt: "revision-1" }}/>
      </QueryClientProvider>);
            await settle();
        });
        await act(settle);
        expect(container.querySelector(".editor-direct-manipulation-cue")).not.toBeNull();
        mocks.renderRecursiveImage.mockClear();
        await click('[aria-label="Take another photo"]');
        const video = container.querySelector("video");
        if (!video)
            throw new Error("Expected retake camera.");
        Object.defineProperties(video, { videoHeight: { value: 480 }, videoWidth: { value: 640 } });
        act(() => { video.dispatchEvent(new Event("loadedmetadata", { bubbles: true })); });
        if (outcome === "cancel") {
            await click('[aria-label="Cancel retake"]');
            const canvas = container.querySelector(".editor-direct-manipulation-cue");
            expect(mocks.renderRecursiveImage).toHaveBeenCalledWith(canvas, original, DEFAULT_SETTINGS);
            expect(mocks.processDesignArtwork).not.toHaveBeenCalled();
        }
        else {
            if (outcome === "confirm-ready") {
                await click('[aria-label="Photo timer: 3 seconds. Change timer"]');
                await click('[aria-label="Photo timer: 5 seconds. Change timer"]');
                await click('[aria-label="Take photo in 10 seconds"]');
                await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
                expect(mocks.processDesignArtwork).not.toHaveBeenCalled();
                await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
            }
            else {
                await click('[aria-label="Take photo in 3 seconds"]');
                await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
            }
            if (outcome !== "confirm-ready" && outcome !== "discard-decoding") {
                await click('[data-confirm-photo]');
            }
            expect(mocks.processDesignArtwork).toHaveBeenCalledOnce();
            expect(mocks.updateDesignSettings).not.toHaveBeenCalled();
            const response = {
                id: "design-1", artworkUrl: "/artwork", preview: new Blob(["replacement"]),
                updatedAt: "revision-2", version: 2,
                diagnostics: { durationMs: 100, requestId: undefined },
            };
            if (outcome === "retry" || outcome === "parse-error" || outcome === "syntax-error") {
                await act(async () => {
                    upload.reject(outcome === "parse-error"
                        ? new ParseResult.ParseError({ issue: new ParseResult.Type(Schema.String.ast, null) })
                        : outcome === "syntax-error"
                            ? new SyntaxError("Malformed upload response")
                            : Object.assign(new Error("Upload failed"), { retryable: false, status: 400 }));
                    await vi.advanceTimersByTimeAsync(20000);
                });
                // An ambiguous response must not replay a possibly committed upload or consumed proof.
                expect(mocks.processDesignArtwork).toHaveBeenCalledOnce();
                expect(container.textContent).toContain("We couldn't prepare your artwork.");
                expect(container.querySelector(".editor-direct-manipulation-cue")).toBeNull();
                mocks.processDesignArtwork.mockResolvedValue(response);
                const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
                    .find(button => button.textContent === "Try again");
                if (!retry)
                    throw new Error("Expected upload retry.");
                await act(async () => { retry.click(); await settle(); });
            }
            else {
                await act(async () => { upload.resolve(response); await settle(); });
            }
            if (outcome === "discard-decoding") {
                const retake = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
                    .find(button => button.textContent === "Retake");
                if (!retake)
                    throw new Error("Expected preview retake.");
                await act(async () => { retake.click(); await settle(); });
                await act(async () => { decode.resolve(replacement); await settle(); });
                expect(replacement.close).toHaveBeenCalledOnce();
                expect(container.querySelector("video")).not.toBeNull();
                expect(container.querySelector("[data-complete-cutout-reveal]")).toBeNull();
                expect(container.querySelector("[data-processing-loader]")).toBeNull();
                act(() => { root.unmount(); });
                queryClient.clear();
                return;
            }
            if (outcome === "confirm-ready") {
                expect(container.querySelector('[aria-label="Photo preview"]')).not.toBeNull();
                expect(container.querySelector("[data-complete-cutout-reveal]")).toBeNull();
                await click('[data-confirm-photo]');
                expect(container.querySelector("[data-processing-loader]")).toBeNull();
            }
            await click("[data-complete-cutout-reveal]");
            const canvas = container.querySelector(".editor-direct-manipulation-cue");
            expect(mocks.renderRecursiveImage).toHaveBeenCalledWith(canvas, replacement, expect.anything());
            expect(original.close).toHaveBeenCalledOnce();
        }
        act(() => { root.unmount(); });
        queryClient.clear();
    });
    it.each([
        { secondaryProductFails: false, inlinePreview: false },
        { secondaryProductFails: true, inlinePreview: false },
        { secondaryProductFails: false, inlinePreview: true },
        { secondaryProductFails: true, inlinePreview: true },
    ])("keeps Continue busy and avoids a preview round trip when supplied: %j", async ({ secondaryProductFails, inlinePreview }) => {
        vi.useFakeTimers();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        vi.stubGlobal("createImageBitmap", vi.fn(() => Promise.resolve({
            close: vi.fn(),
            height: 1000,
            width: 1000,
        })));
        vi.stubGlobal("URL", class extends URL {
            static override createObjectURL = vi.fn(() => "blob:test");
            static override revokeObjectURL = vi.fn();
        });
        Object.defineProperty(window, "isSecureContext", {
            configurable: true,
            value: true,
        });
        const track = {
            getSettings: () => ({ facingMode: "user", deviceId: "front" }),
            applyConstraints: vi.fn(() => Promise.resolve()),
            getCapabilities: vi.fn(() => ({ height: { max: 4096 }, width: { max: 4096 } })),
            stop: vi.fn(),
        };
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                addEventListener: vi.fn(), removeEventListener: vi.fn(),
                getUserMedia: () => Promise.resolve({
                    getTracks: () => [track],
                    getVideoTracks: () => [track],
                }),
            },
        });
        Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
            configurable: true,
            writable: true,
            value: null,
        });
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
            configurable: true,
            value: vi.fn(() => ({
                drawImage: vi.fn(),
                scale: vi.fn(),
                translate: vi.fn(),
            })),
        });
        let canvasEncodes = 0;
        const encodeCanvas = vi.fn((callback: BlobCallback) => {
            canvasEncodes += 1;
            callback(new Blob([
                canvasEncodes === 1
                    ? new Uint8Array(20000000 + 1)
                    : new Uint8Array([0xff, 0xd8, 0xff]),
            ], { type: "image/jpeg" }));
        });
        HTMLCanvasElement.prototype.toBlob = encodeCanvas;
        const preview = new Blob([new Uint8Array([82, 73, 70, 70])], { type: "image/webp" });
        const artworkRequest = Promise.withResolvers<Blob>();
        mocks.getArtworkPreview.mockImplementation(() => artworkRequest.promise);
        let resolveArtwork: ((value: {
            artworkUrl: string;
            preview?: Blob;
            diagnostics: {
                durationMs: number;
                requestId: string | undefined;
            };
            id: string;
            updatedAt: string;
            version: number;
        }) => void) | undefined;
        mocks.processDesignArtwork.mockImplementation(() => new Promise((resolve) => {
            resolveArtwork = resolve;
        }));
        mocks.updateDesignSettings.mockResolvedValue({
            diagnostics: { attemptCount: 1, requestId: "request-initial" },
            updatedAt: "2026-08-21T01:00:01.000Z",
            version: 2,
        });
        mocks.createConfiguredProductFamily.mockReset().mockResolvedValue(secondaryProductFails ? [{ id: "product-1" }] : [{ id: "product-1" }, { id: "product-2" }]);
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        });
        const navigationReady = Promise.withResolvers<undefined>();
        function ProductDestination() {
            use(navigationReady.promise);
            return <p>Product page</p>;
        }
        function NavigationHarness() {
            const [navigated, setNavigated] = useState(false);
            mocks.routerReplace.mockImplementation(() => { setNavigated(true); });
            return navigated ? <ProductDestination /> : (<ShirtEditor baseProductAvailability="available" initialDesign={{
                    id: "design-1",
                    settings: DEFAULT_SETTINGS,
                    status: "creating",
                    updatedAt: "2026-08-21T01:00:00.000Z",
                }}/>);
        }
        act(() => {
            root.render(<QueryClientProvider client={queryClient}>
          <Suspense fallback={<p>Loading route</p>}>
            <NavigationHarness />
          </Suspense>
        </QueryClientProvider>);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        const video = container.querySelector("video");
        if (!video)
            throw new Error("Expected the camera preview.");
        Object.defineProperties(video, {
            videoHeight: { configurable: true, value: 3000 },
            videoWidth: { configurable: true, value: 4000 },
        });
        act(() => {
            video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
        });
        const capture = container.querySelector<HTMLButtonElement>('[aria-label="Take photo in 3 seconds"]');
        if (!capture)
            throw new Error("Expected the camera capture control.");
        await act(async () => {
            capture.click();
            await vi.runAllTimersAsync();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mocks.processDesignArtwork).toHaveBeenCalledOnce();
        expect(encodeCanvas).toHaveBeenCalledTimes(2);
        expect(mocks.removeBackground).not.toHaveBeenCalled();
        expect(mocks.updateDesignSettings).not.toHaveBeenCalled();
        expect(mocks.createConfiguredProductFamily).not.toHaveBeenCalled();
        expect(container.querySelector('[aria-label="Photo preview"]')).not.toBeNull();
        expect(container.querySelector("[data-processing-loader]")).toBeNull();
        const confirm = container.querySelector<HTMLButtonElement>("[data-confirm-photo]");
        if (!confirm)
            throw new Error("Expected photo confirmation.");
        act(() => { confirm.click(); });
        expect(container.querySelector("[data-processing-loader]")).not.toBeNull();
        const finishArtwork = resolveArtwork;
        if (!finishArtwork)
            throw new Error("Expected the artwork upload to start.");
        await act(async () => {
            finishArtwork({
                artworkUrl: "/v1/designs/design-1/artwork",
                ...(inlinePreview ? { preview } : {}),
                diagnostics: {
                    durationMs: 2000,
                    requestId: "upload-request-success",
                },
                id: "design-1",
                updatedAt: "2026-08-21T01:00:01.000Z",
                version: 1,
            });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        if (inlinePreview) {
            expect(mocks.getArtworkPreview).not.toHaveBeenCalled();
        }
        else {
            expect(mocks.getArtworkPreview).toHaveBeenCalledWith("design-1", "2026-08-21T01:00:01.000Z");
            expect(mocks.getArtworkPreview).toHaveBeenCalledOnce();
        }
        await act(async () => {
            artworkRequest.resolve(preview);
            await artworkRequest.promise;
            await Promise.resolve();
            await vi.runAllTimersAsync();
            await Promise.resolve();
            await Promise.resolve();
        });
        const minimapCanvas = container.querySelector<HTMLCanvasElement>("[data-editor-minimap]");
        if (!minimapCanvas)
            throw new Error("Expected the live editor minimap.");
        expect(mocks.renderRecursiveImage).toHaveBeenCalledWith(minimapCanvas, expect.anything(), expect.anything());
        expect(container.querySelector('input[type="range"]')).toBeNull();
        expect(container.querySelector(".editor-direct-manipulation-cue"))
            .toBeNull();
        const completeReveal = container.querySelector<HTMLButtonElement>("[data-complete-cutout-reveal]");
        if (!completeReveal)
            throw new Error("Expected the cutout reveal.");
        act(() => {
            completeReveal.click();
        });
        expect(container.querySelector(".editor-direct-manipulation-cue"))
            .not.toBeNull();
        expect(mocks.updateDesignSettings).toHaveBeenCalledOnce();
        let resolveFirstAdjustment: ((value: {
            diagnostics: {
                attemptCount: number;
                requestId: string;
            };
            updatedAt: string;
            version: number;
        }) => void) | undefined;
        mocks.updateDesignSettings.mockImplementationOnce(() => new Promise((resolve) => {
            resolveFirstAdjustment = resolve;
        }));
        mocks.updateDesignSettings.mockResolvedValue({
            diagnostics: { attemptCount: 1, requestId: "request-latest" },
            updatedAt: "2026-08-21T01:00:03.000Z",
            version: 4,
        });
        const editorCanvas = container.querySelector<HTMLCanvasElement>(".editor-direct-manipulation-cue");
        const editorSurface = editorCanvas?.parentElement;
        if (!editorSurface)
            throw new Error("Expected the direct manipulation surface.");
        Object.defineProperty(editorSurface, "getBoundingClientRect", {
            configurable: true,
            value: () => ({
                bottom: 1200,
                height: 1200,
                left: 0,
                right: 1000,
                top: 0,
                width: 1000,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }),
        });
        const capturedPointers = new Set<number>();
        Object.defineProperties(editorSurface, {
            hasPointerCapture: {
                configurable: true,
                value: (pointerId: number) => capturedPointers.has(pointerId),
            },
            releasePointerCapture: {
                configurable: true,
                value: (pointerId: number) => capturedPointers.delete(pointerId),
            },
            setPointerCapture: {
                configurable: true,
                value: (pointerId: number) => capturedPointers.add(pointerId),
            },
        });
        const adjust = async (pointerId: number, distance: number) => {
            editorSurface.dispatchEvent(new PointerEvent("pointerdown", {
                bubbles: true,
                clientX: 500,
                clientY: 600,
                pointerId,
            }));
            editorSurface.dispatchEvent(new PointerEvent("pointermove", {
                bubbles: true,
                clientX: 500 + distance,
                clientY: 600,
                pointerId,
            }));
            editorSurface.dispatchEvent(new PointerEvent("pointerup", {
                bubbles: true,
                clientX: 500 + distance,
                clientY: 600,
                pointerId,
            }));
            await vi.advanceTimersByTimeAsync(180);
            await Promise.resolve();
        };
        await act(async () => {
            await adjust(1, 10);
            await adjust(2, 20);
            await adjust(3, 30);
        });
        expect(mocks.updateDesignSettings).toHaveBeenCalledTimes(2);
        const continueButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Continue");
        if (!continueButton)
            throw new Error("Expected the Continue control.");
        expect(continueButton.disabled).toBe(false);
        expect(mocks.createConfiguredProductFamily).not.toHaveBeenCalled();
        await act(async () => {
            continueButton.click();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mocks.createConfiguredProductFamily).not.toHaveBeenCalled();
        const finishFirstAdjustment = resolveFirstAdjustment;
        expect(continueButton.textContent).toBe("Preparing…");
        expect(continueButton.disabled).toBe(true);
        expect(continueButton.getAttribute("aria-busy")).toBe("true");
        expect(editorSurface.getAttribute("aria-disabled")).toBe("true");
        const retakeButton = container.querySelector<HTMLButtonElement>('[aria-label="Take another photo"]');
        if (!retakeButton)
            throw new Error("Expected the Retake control.");
        expect(retakeButton.disabled).toBe(true);
        if (!finishFirstAdjustment) {
            throw new Error("Expected the first adjustment save to start.");
        }
        await act(async () => {
            finishFirstAdjustment({
                diagnostics: { attemptCount: 1, requestId: "request-first" },
                updatedAt: "2026-08-21T01:00:02.000Z",
                version: 3,
            });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mocks.updateDesignSettings).toHaveBeenCalledTimes(3);
        expect(mocks.createConfiguredProductFamily).toHaveBeenCalledTimes(1);
        expect(mocks.createConfiguredProductFamily).toHaveBeenCalledWith({
            baseProductIds: ["a51b7acf-77e9-4762-83c4-62d96dd8942c", "97b629d7-1d3b-4d2a-a586-537168141e97"],
            designId: "design-1",
        });
        expect(mocks.routerReplace).toHaveBeenCalledWith("/product/product-1");
        expect(continueButton.textContent).toBe("Opening…");
        expect(continueButton.disabled).toBe(true);
        expect(continueButton.getAttribute("aria-busy")).toBe("true");
        expect(container.textContent).not.toContain("Loading route");
        await act(async () => {
            navigationReady.resolve(undefined);
            await navigationReady.promise;
        });
        expect(container.textContent).toBe("Product page");
        act(() => { root.unmount(); });
    });
    it("shows a recoverable error when the first artwork upload fails", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        vi.stubGlobal("URL", class extends URL {
            static override createObjectURL = vi.fn(() => "blob:captured-photo");
            static override revokeObjectURL = vi.fn();
        });
        Object.defineProperty(window, "isSecureContext", {
            configurable: true,
            value: true,
        });
        const track = {
            getSettings: () => ({ facingMode: "user", deviceId: "front" }),
            applyConstraints: vi.fn(() => Promise.resolve()),
            getCapabilities: vi.fn(() => ({
                height: { max: 4096 },
                width: { max: 4096 },
            })),
            stop: vi.fn(),
        };
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                addEventListener: vi.fn(), removeEventListener: vi.fn(),
                getUserMedia: () => Promise.resolve({
                    getTracks: () => [track],
                    getVideoTracks: () => [track],
                }),
            },
        });
        Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
            configurable: true,
            value: null,
            writable: true,
        });
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
            configurable: true,
            value: vi.fn(() => ({
                drawImage: vi.fn(),
                scale: vi.fn(),
                translate: vi.fn(),
            })),
        });
        HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
            callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
                type: "image/jpeg",
            }));
        });
        const uploadError = Object.assign(new Error("Preparing the photo took too long. Please try again."), {
            code: "REQUEST_TIMEOUT",
            requestId: "upload-request-1",
            retryable: false,
            status: 0,
        });
        mocks.processDesignArtwork.mockRejectedValue(uploadError);
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        });
        await act(async () => {
            root.render(<QueryClientProvider client={queryClient}>
          <ShirtEditor initialDesign={{
                    id: "design-1",
                    settings: DEFAULT_SETTINGS,
                    status: "creating",
                    updatedAt: "2026-09-02T00:00:00.000Z",
                }}/>
        </QueryClientProvider>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const video = container.querySelector("video");
        if (!video)
            throw new Error("Expected the camera preview.");
        Object.defineProperties(video, {
            videoHeight: { configurable: true, value: 3000 },
            videoWidth: { configurable: true, value: 4000 },
        });
        act(() => {
            video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
        });
        const capture = container.querySelector<HTMLButtonElement>('[aria-label="Take photo in 3 seconds"]');
        if (!capture)
            throw new Error("Expected the camera capture control.");
        await act(async () => {
            capture.click();
            await vi.runAllTimersAsync();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mocks.processDesignArtwork).toHaveBeenCalledOnce();
        expect(container.querySelector('[aria-label="Photo preview"]')).not.toBeNull();
        const confirm = container.querySelector<HTMLButtonElement>("[data-confirm-photo]");
        if (!confirm)
            throw new Error("Expected photo confirmation.");
        act(() => { confirm.click(); });
        expect(container.textContent).toContain("We couldn't prepare your artwork.");
        expect(container.textContent).not.toContain("Preparing camera");
        expect(container.textContent).toContain("Reference: upload-request-1");
        const failureTrace = mocks.reportCreationTrace.mock.calls
            .map(([event]) => event)
            .find((event) => event.stage === "artwork_upload_failed");
        expect(typeof failureTrace?.attemptId).toBe("string");
        expect(failureTrace?.code).toBe("REQUEST_TIMEOUT");
        expect(failureTrace?.designId).toBe("design-1");
        expect(typeof failureTrace?.durationMs).toBe("number");
        expect(failureTrace?.requestId).toBe("upload-request-1");
        expect(failureTrace?.status).toBe(0);
        act(() => { root.unmount(); });
    });
});
