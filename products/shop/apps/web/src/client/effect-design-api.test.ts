import { protectedConfig } from "../../../../scripts/protected-config.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesign, designApiErrorMetadata, getDesign, getSavedDesigns, processDesignArtwork, removeBackground, updateDesignSettings, } from "./effect-design-api";
const DESIGN_ID = protectedConfig("resource_83abf907850d");
const LEGACY_ID = protectedConfig("resource_e17990f19034");
const CONFLICT_ID = "4fdd5990-f32d-4e21-a1ab-40a516805c42";
const RATE_LIMIT_ID = "962db273-3979-4743-8870-fdb5e7279ac0";
const SETTINGS = {
    cropX: 0.5,
    cropY: 0.5,
    cropZoom: 1,
    placementX: 0.39,
    placementY: 0.43,
    placementWidth: 0.22,
    depth: 5,
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("anonymous browser design API", () => {
    it.each(["grant", "upload"])("refreshes a version conflict during artwork %s once with a fresh grant", async (conflictAt) => {
        const image = new Blob(["replacement portrait"], { type: "image/jpeg" });
        const grantBodies: unknown[] = [];
        const uploads: RequestInit[] = [];
        const signals: (AbortSignal | null | undefined)[] = [];
        const proofs: (string | null)[] = [];
        let grantCount = 0;
        let refreshes = 0;
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: CONFLICT_ID, version: 5 }));
            }
            signals.push(init?.signal);
            if (url.endsWith("/upload-grants")) {
                proofs.push(new Headers(init?.headers).get("x-turnstile-token"));
                grantCount += 1;
                grantBodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
                if (conflictAt === "grant" && grantCount === 1) {
                    return Promise.resolve(Response.json({
                        error: { code: "VERSION_CONFLICT", message: "The draft changed." },
                    }, { status: 409 }));
                }
                return Promise.resolve(Response.json({
                    uploadUrl: `https://api.example.com/v2/design-upload-grants?token=private-${String(grantCount)}`,
                    expiresAt: "2026-10-23T00:45:00.000Z",
                }, { status: 201 }));
            }
            if (init?.method === "PUT") {
                uploads.push(init);
                if (conflictAt === "upload" && uploads.length === 1) {
                    return Promise.resolve(Response.json({
                        error: { code: "VERSION_CONFLICT", message: "The draft changed or this grant was already used." },
                    }, { status: 409 }));
                }
                return Promise.resolve(Response.json({
                    id: CONFLICT_ID, version: 7,
                    artworkUrl: `/v1/designs/${CONFLICT_ID}/artwork`,
                    updatedAt: "2026-10-23T00:40:00.000Z",
                }, { status: 202, headers: { "x-request-id": "replacement-upload" } }));
            }
            refreshes += 1;
            return Promise.resolve(Response.json({
                id: CONFLICT_ID, version: 6, status: "ready", contentType: "image/webp",
                settings: SETTINGS, finalized: false,
                artworkUrl: `/v1/designs/${CONFLICT_ID}/artwork`,
                createdAt: "2026-10-23T00:38:00.000Z", updatedAt: "2026-10-23T00:39:21.000Z",
            }));
        });
        await createDesign("challenge-token");
        const result = await processDesignArtwork(CONFLICT_ID, image, "fresh-proof");
        expect(proofs).toEqual(["fresh-proof", null]);
        expect(result.diagnostics.requestId).toBe("replacement-upload");
        expect(refreshes).toBe(1);
        expect(grantBodies).toEqual([5, 6].map(expectedVersion => ({
            contentType: "image/jpeg", maxBytes: image.size, progressive: true, expectedVersion,
        })));
        expect(uploads).toHaveLength(conflictAt === "upload" ? 2 : 1);
        expect(uploads.every(upload => upload.body === image)).toBe(true);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(signals.every(signal => signal === signals[0])).toBe(true);
    });
    it.each([
        { status: 409, code: "VERSION_CONFLICT", attempts: 2 },
        { status: 409, code: "DRAFT_FINALIZED", attempts: 1 },
        { status: 429, code: "RATE_LIMITED", attempts: 1 },
        { status: 503, code: "DEPENDENCY_UNAVAILABLE", attempts: 1 },
    ])("bounds artwork retries for $status $code", async ({ status, code, attempts }) => {
        let grants = 0;
        let uploads = 0;
        let refreshes = 0;
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: CONFLICT_ID, version: 5 }));
            }
            if (url.endsWith("/upload-grants")) {
                grants += 1;
                return Promise.resolve(Response.json({
                    uploadUrl: `https://api.example.com/v2/design-upload-grants?token=private-${String(grants)}`,
                    expiresAt: "2026-10-23T00:45:00.000Z",
                }, { status: 201 }));
            }
            if (init?.method === "PUT") {
                uploads += 1;
                return Promise.resolve(Response.json({ error: { code, message: "Upload rejected." } }, {
                    status, headers: { "x-request-id": `failed-upload-${String(uploads)}` },
                }));
            }
            refreshes += 1;
            return Promise.resolve(Response.json({
                id: CONFLICT_ID, version: 6, status: "ready", contentType: "image/webp",
                settings: SETTINGS, finalized: false,
                artworkUrl: `/v1/designs/${CONFLICT_ID}/artwork`,
                createdAt: "2026-10-23T00:38:00.000Z", updatedAt: "2026-10-23T00:39:21.000Z",
            }));
        });
        await createDesign("challenge-token");
        const error = await processDesignArtwork(CONFLICT_ID, new Blob(["portrait"], { type: "image/jpeg" }))
            .catch((caught: unknown) => caught);
        expect(designApiErrorMetadata(error)).toMatchObject({
            status, code, attemptCount: attempts, requestId: `failed-upload-${String(attempts)}`,
        });
        expect(grants).toBe(attempts);
        expect(uploads).toBe(attempts);
        expect(refreshes).toBe(attempts - 1);
    });
    it("requests bounded pages with an encoded cursor, no cache and cancellation", async () => {
        const fetcher = vi.fn(() => Promise.resolve(Response.json({ items: [], nextCursor: null })));
        vi.stubGlobal("fetch", fetcher);
        const signal = new AbortController().signal;
        const cursor = `v1.1700000000000.${DESIGN_ID}`;
        expect(await getSavedDesigns(cursor, signal)).toEqual({ items: [], nextCursor: null });
        expect(fetcher).toHaveBeenCalledWith(`/api/design-drafts?page=1&cursor=${cursor}`, expect.objectContaining({ cache: "no-store", signal }));
    });
    it.each([
        [], { items: [], nextCursor: "bad" },
        { items: Array.from({ length: 41 }, () => ({ id: DESIGN_ID, productId: DESIGN_ID, color: "White", createdAt: "2026-09-09" })), nextCursor: null },
    ])("rejects incompatible or unbounded page responses %#", async (payload) => {
        vi.stubGlobal("fetch", () => Promise.resolve(Response.json(payload)));
        await expect(getSavedDesigns(null)).rejects.toThrow();
    });
    it.each([false, true])("separates transfer phases, browser network timings visible=%s", async (networkVisible) => {
        let elapsed = 0;
        vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        const timing = {
            name: "https://api.example.com/v2/design-upload-grants?token=private",
            entryType: "resource", startTime: 250, duration: 13000,
            requestStart: networkVisible ? 1050 : 0,
            responseStart: networkVisible ? 8250 : 0,
            toJSON: () => ({}),
        };
        vi.spyOn(performance, "getEntriesByName").mockReturnValue([timing]);
        vi.stubGlobal("fetch", (input: string | URL | Request) => {
            const url = requestUrl(input);
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: DESIGN_ID, version: 0 }, { status: 201 }));
            }
            if (url.endsWith("/upload-grants")) {
                elapsed += 250;
                return Promise.resolve(Response.json({
                    uploadUrl: "https://api.example.com/v2/design-upload-grants?token=private",
                    expiresAt: "2026-08-16T00:05:00.000Z",
                }, { status: 201 }));
            }
            elapsed += 8000;
            const payload = {
                id: DESIGN_ID, artworkUrl: `/v1/designs/${DESIGN_ID}/artwork`,
                updatedAt: "2026-08-16T00:00:01.000Z", version: 1,
                preview: { contentType: "image/webp", base64: "AQID" },
            };
            const response = Response.json(payload, {
                headers: { "server-timing": "worker;dur=5500, upload-body;dur=1000, portrait-processing;dur=3000" },
            });
            vi.spyOn(response, "json").mockImplementation(() => {
                elapsed += 5000;
                return Promise.resolve(payload);
            });
            return Promise.resolve(response);
        });
        await createDesign("challenge-token");
        const result = await processDesignArtwork(DESIGN_ID, new Blob(["jpeg"], { type: "image/jpeg" }));
        expect(result.diagnostics).toMatchObject({
            durationMs: 13250, grantDurationMs: 250, uploadResponseDurationMs: 8000,
            responseDownloadDurationMs: 5000, workerDurationMs: 5500,
            uploadBodyDurationMs: 1000, portraitDurationMs: 3000, previewBytes: 3,
            networkSetupDurationMs: networkVisible ? 800 : undefined,
            networkRequestDurationMs: networkVisible ? 7200 : undefined,
        });
    });
    it("routes paid preview processing through the same-origin service BFF", async () => {
        const calls: string[] = [];
        vi.stubGlobal("fetch", (input: string | URL | Request) => {
            calls.push(requestUrl(input));
            return Promise.resolve(new Response(new Uint8Array([137, 80, 78, 71]), {
                headers: { "content-type": "image/png" },
            }));
        });
        await removeBackground(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
            type: "image/jpeg",
        }), "preview");
        expect(calls).toEqual(["/api/background-removal"]);
    });
    it("uses the same-origin BFF for draft control-plane calls", async () => {
        const calls: {
            input: string;
            init: RequestInit | undefined;
        }[] = [];
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            calls.push({ input: url, init });
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: DESIGN_ID, version: 0 }, { status: 201 }));
            }
            return Promise.resolve(Response.json({
                id: DESIGN_ID,
                updatedAt: "2026-08-16T00:00:00.000Z",
                version: 1,
            }));
        });
        await createDesign("challenge-token");
        await updateDesignSettings(DESIGN_ID, SETTINGS);
        expect(calls.map(({ input }) => input)).toEqual([
            "/api/design-drafts",
            `/api/design-drafts/${DESIGN_ID}`,
        ]);
        expect(new Headers(calls[0]?.init?.headers).get("x-turnstile-token")).toBe("challenge-token");
        const patchBody = calls[1]?.init?.body;
        expect(typeof patchBody === "string" ? JSON.parse(patchBody) : undefined).toEqual({
            expectedVersion: 0,
            settings: SETTINGS,
        });
    });
    it.each([
        { preview: undefined, expectedBytes: undefined },
        { preview: { contentType: "image/webp", base64: "AQID" }, expectedBytes: 3 },
        { preview: { contentType: "image/webp", base64: "invalid!" }, expectedBytes: undefined },
        { preview: { contentType: "image/jpeg", base64: "AQID" }, expectedBytes: undefined },
        { preview: { contentType: "image/webp", base64: "A".repeat(1398105) }, expectedBytes: undefined },
    ])("uses one grant/upload pair and safely decodes an optional preview, case %#", async ({ preview, expectedBytes }) => {
        const calls: {
            signal: AbortSignal | null | undefined;
            url: string;
        }[] = [];
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            calls.push({ signal: init?.signal, url });
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: DESIGN_ID, version: 0 }, { status: 201 }));
            }
            if (url.endsWith("/upload-grants")) {
                return Promise.resolve(Response.json({
                    uploadUrl: "https://api.example.com/v2/design-upload-grants?token=private",
                    expiresAt: "2026-08-16T00:05:00.000Z",
                }, {
                    headers: { "x-request-id": "grant-request" },
                    status: 201,
                }));
            }
            return Promise.resolve(Response.json({
                id: DESIGN_ID,
                artworkUrl: `/v1/designs/${DESIGN_ID}/artwork`,
                updatedAt: "2026-08-16T00:00:01.000Z",
                version: 2,
                preview,
            }, { headers: { "server-timing": "safety-screening;dur=820, artwork-preview;dur=140, worker;dur=2100" } }));
        });
        await createDesign("challenge-token");
        const result = await processDesignArtwork(DESIGN_ID, new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
        expect(calls.map(({ url }) => url)).toEqual([
            "/api/design-drafts",
            `/api/design-drafts/${DESIGN_ID}/upload-grants`,
            "https://api.example.com/v2/design-upload-grants?token=private",
        ]);
        expect(calls.slice(1).every(({ signal }) => signal instanceof AbortSignal))
            .toBe(true);
        expect(result.diagnostics.requestId).toBe("grant-request");
        expect(result.preview?.size).toBe(expectedBytes);
        expect(result.diagnostics).toMatchObject({
            screeningDurationMs: 820,
            previewDurationMs: 140,
            workerDurationMs: 2100,
        });
    });
    it.each([
        new DOMException("Timed out", "TimeoutError"),
        Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
        new DOMException("The operation was aborted.", "AbortError"),
    ])("turns an ambiguous browser upload interruption into a non-retryable error: $name", async (interruption) => {
        vi.stubGlobal("fetch", (input: string | URL | Request) => {
            const url = requestUrl(input);
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: DESIGN_ID, version: 0 }, { status: 201 }));
            }
            if (url.endsWith("/upload-grants")) {
                return Promise.resolve(Response.json({
                    uploadUrl: "https://api.example.com/v2/design-upload-grants?token=private",
                    expiresAt: "2026-08-16T00:05:00.000Z",
                }, {
                    headers: { "x-request-id": "grant-request" },
                    status: 201,
                }));
            }
            return Promise.reject(interruption);
        });
        await createDesign("challenge-token");
        const error = await processDesignArtwork(DESIGN_ID, new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" })).catch((caught: unknown) => caught);
        expect(designApiErrorMetadata(error)).toEqual({
            attemptCount: 1,
            code: "REQUEST_TIMEOUT",
            requestId: "grant-request",
            retryable: false,
            retryAfterSeconds: undefined,
            status: 0,
        });
    });
    it.each([
        { duration: 35000, ok: true },
        { duration: 95000, ok: true },
        { duration: 185000, ok: false },
    ])("bounds a slow mobile upload without replaying it: $duration ms", async ({ duration, ok }) => {
        vi.useFakeTimers();
        vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
            const controller = new AbortController();
            setTimeout(() => { controller.abort(new DOMException("Timed out", "TimeoutError")); }, milliseconds);
            return controller.signal;
        });
        let uploads = 0;
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: DESIGN_ID, version: 0 }, { status: 201 }));
            }
            if (url.endsWith("/upload-grants")) {
                return Promise.resolve(Response.json({ uploadUrl: "https://api.example.com/v2/design-upload-grants?token=private", expiresAt: "2099-01-01T00:00:00Z" }));
            }
            uploads += 1;
            return new Promise<Response>((resolve, reject) => {
                init?.signal?.addEventListener("abort", () => { reject(new DOMException("Timed out", "TimeoutError")); }, { once: true });
                setTimeout(() => { resolve(Response.json({ id: DESIGN_ID, version: 1, artworkUrl: "/artwork", updatedAt: "2026-09-17T00:00:00Z" })); }, duration);
            });
        });
        try {
            await createDesign("challenge-token");
            const completed = processDesignArtwork(DESIGN_ID, new Blob(["jpeg"], { type: "image/jpeg" }))
                .then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, metadata: designApiErrorMetadata(error) }));
            await vi.advanceTimersByTimeAsync(Math.min(duration, 180000));
            expect(await completed).toMatchObject(ok ? { ok: true } : {
                ok: false, metadata: { code: "REQUEST_TIMEOUT", retryable: false },
            });
            expect(uploads).toBe(1);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it("does not let a stale draft read roll back the version after artwork processing", async () => {
        const patchBodies: unknown[] = [];
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: DESIGN_ID, version: 0 }, { status: 201 }));
            }
            if (url.endsWith("/upload-grants")) {
                return Promise.resolve(Response.json({
                    uploadUrl: "https://api.example.com/v2/design-upload-grants?token=private",
                    expiresAt: "2026-08-16T00:05:00.000Z",
                }, { status: 201 }));
            }
            if (url === "https://api.example.com/v2/design-upload-grants?token=private") {
                return Promise.resolve(Response.json({
                    id: DESIGN_ID,
                    artworkUrl: `/v1/designs/${DESIGN_ID}/artwork`,
                    updatedAt: "2026-08-16T00:00:01.000Z",
                    version: 1,
                }));
            }
            if (init?.method === "PATCH") {
                patchBodies.push(typeof init.body === "string" ? JSON.parse(init.body) : undefined);
                return Promise.resolve(Response.json({
                    id: DESIGN_ID,
                    updatedAt: "2026-08-16T00:00:02.000Z",
                    version: 2,
                }));
            }
            return Promise.resolve(Response.json({
                id: DESIGN_ID,
                status: "creating",
                contentType: "application/octet-stream",
                createdAt: "2026-08-16T00:00:00.000Z",
                updatedAt: "2026-08-16T00:00:00.000Z",
                settings: SETTINGS,
                artworkUrl: `/v1/designs/${DESIGN_ID}/artwork`,
                version: 0,
                finalized: false,
            }));
        });
        await createDesign("challenge-token");
        await processDesignArtwork(DESIGN_ID, new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
        await getDesign(DESIGN_ID);
        await updateDesignSettings(DESIGN_ID, SETTINGS);
        expect(patchBodies).toEqual([{ expectedVersion: 1, settings: SETTINGS }]);
    });
    it("rejects print artwork above the Worker limit before requesting a grant", async () => {
        const calls: string[] = [];
        vi.stubGlobal("fetch", (input: string | URL | Request) => {
            const url = requestUrl(input);
            calls.push(url);
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: DESIGN_ID, version: 0 }, { status: 201 }));
            }
            return Promise.resolve(Response.json({ error: { message: "Valid upload constraints are required." } }, { status: 400 }));
        });
        await createDesign("challenge-token");
        const oversized = new Blob([new Uint8Array(20000000 + 1)], { type: "image/jpeg" });
        await expect(processDesignArtwork(DESIGN_ID, oversized)).rejects.toThrow("Print artwork must be no larger than 20 MB.");
        expect(calls).toEqual(["/api/design-drafts"]);
    });
    it("claims an unowned legacy draft only when the user starts a mutation", async () => {
        const calls: string[] = [];
        vi.stubGlobal("fetch", (input: string | URL | Request) => {
            const url = requestUrl(input);
            calls.push(url);
            if (calls.length === 1) {
                return Promise.resolve(Response.json({ error: { message: "Design not found." } }, { status: 404 }));
            }
            if (url.endsWith("/claim")) {
                return Promise.resolve(Response.json({
                    id: LEGACY_ID,
                    status: "creating",
                    contentType: "application/octet-stream",
                    createdAt: "2026-08-16T00:00:00.000Z",
                    updatedAt: "2026-08-16T00:00:00.000Z",
                    settings: SETTINGS,
                    artworkUrl: `/v1/designs/${LEGACY_ID}/artwork`,
                    version: 0,
                    finalized: false,
                }));
            }
            return Promise.resolve(Response.json({
                id: LEGACY_ID,
                updatedAt: "2026-08-16T00:00:01.000Z",
                version: 1,
            }));
        });
        await updateDesignSettings(LEGACY_ID, SETTINGS);
        expect(calls).toEqual([
            `/api/design-drafts/${LEGACY_ID}`,
            `/api/design-drafts/${LEGACY_ID}/claim`,
            `/api/design-drafts/${LEGACY_ID}`,
        ]);
    });
    it("refreshes a stale version once and exposes response diagnostics", async () => {
        const patchBodies: unknown[] = [];
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: CONFLICT_ID, version: 2 }));
            }
            if (init?.method === "PATCH") {
                patchBodies.push(typeof init.body === "string" ? JSON.parse(init.body) : undefined);
                if (patchBodies.length === 1) {
                    return Promise.resolve(Response.json({ error: { code: "VERSION_CONFLICT", message: "Version changed." } }, { headers: { "x-request-id": "request-conflict" }, status: 409 }));
                }
                return Promise.resolve(Response.json({
                    id: CONFLICT_ID,
                    updatedAt: "2026-08-16T00:00:02.000Z",
                    version: 4,
                }, { headers: { "x-request-id": "request-success" } }));
            }
            if (url.endsWith(CONFLICT_ID)) {
                return Promise.resolve(Response.json({
                    id: CONFLICT_ID,
                    status: "ready",
                    contentType: "image/jpeg",
                    createdAt: "2026-08-16T00:00:00.000Z",
                    updatedAt: "2026-08-16T00:00:01.000Z",
                    settings: SETTINGS,
                    artworkUrl: `/v1/designs/${CONFLICT_ID}/artwork`,
                    version: 3,
                    finalized: false,
                }));
            }
            return Promise.reject(new Error(`Unexpected request: ${url}`));
        });
        await createDesign("challenge-token");
        const result = await updateDesignSettings(CONFLICT_ID, SETTINGS);
        expect(patchBodies).toEqual([
            { expectedVersion: 2, settings: SETTINGS },
            { expectedVersion: 3, settings: SETTINGS },
        ]);
        expect(result.diagnostics).toEqual({
            attemptCount: 2,
            requestId: "request-success",
        });
    });
    it("preserves rate-limit metadata for actionable logging and retry UI", async () => {
        vi.stubGlobal("fetch", (input: string | URL | Request) => {
            if (requestUrl(input) === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: RATE_LIMIT_ID, version: 0 }));
            }
            return Promise.resolve(Response.json({ error: { code: "RATE_LIMITED", message: "Too many requests." } }, {
                headers: { "retry-after": "60", "x-request-id": "request-limited" },
                status: 429,
            }));
        });
        await createDesign("challenge-token");
        const error = await updateDesignSettings(RATE_LIMIT_ID, SETTINGS).catch((caught: unknown) => caught);
        expect(designApiErrorMetadata(error)).toEqual({
            attemptCount: 1,
            code: "RATE_LIMITED",
            requestId: "request-limited",
            retryable: false,
            retryAfterSeconds: 60,
            status: 429,
        });
    });
});
function requestUrl(input: string | URL | Request) {
    if (typeof input === "string")
        return input;
    return input instanceof URL ? input.toString() : input.url;
}
it("stops repeated challenge denials after one grant request per deliberate attempt", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/upload-grants")) {
            calls.push(new Headers(init?.headers).get("x-turnstile-token") ?? "no-proof");
            return Promise.resolve(Response.json({ error: { code: "CHALLENGE_REQUIRED", message: "Retry." } }, { status: 403 }));
        }
        if (init?.method === "PUT")
            throw new Error("Denied proof must not upload source bytes");
        return Promise.resolve(Response.json({
            id: DESIGN_ID, version: 19, status: "ready", finalized: false, contentType: "image/webp",
            settings: SETTINGS, artworkUrl: "/fixture/artwork", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z",
        }));
    });
    for (const token of [undefined, "fresh-proof-1", "fresh-proof-2"]) {
        const error = await processDesignArtwork(DESIGN_ID, new Blob(["source"], { type: "image/png" }), token).catch((error: unknown) => error);
        expect(designApiErrorMetadata(error)).toMatchObject({ status: 403, code: "CHALLENGE_REQUIRED", attemptCount: 1 });
    }
    expect(calls).toEqual(["no-proof", "fresh-proof-1", "fresh-proof-2"]);
});
