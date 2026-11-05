import { protectedConfig } from "../../../../../../../scripts/protected-config.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anonymousOwnerId, ANONYMOUS_SESSION_COOKIE } from "@/server/anonymous-session-core";
import { createAbuseClearance, hasAbuseClearance } from "@/server/design-draft-bff-core";
import { configuredProductFamilyBff } from "@/server/design-draft-bff";
import { GET, PATCH, POST } from "./route";
const mocks = vi.hoisted(() => ({
    cookies: new Map<string, string>(),
    setCookie: vi.fn<(name: string, value: string, options: object) => void>(),
    fetch: vi.fn<typeof fetch>(),
}));
vi.mock("@/env", () => ({ env: {
        FOREVER_TEE_API_URL: "https://worker.example",
        FOREVER_TEE_API_SHARED_SECRET: "test-service-secret",
        TURNSTILE_SECRET: "test-turnstile-secret",
    } }));
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({
        get: (name: string) => {
            const value = mocks.cookies.get(name);
            return value === undefined ? undefined : { name, value };
        },
        set: mocks.setCookie,
    }) }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
const origin = "https://shop.bent.build";
const savedPage = { items: [{
            id: protectedConfig("resource_83abf907850d"),
            productId: "4c22bf7e-e698-4a0a-90c4-66c5549f1c45",
            color: "White", createdAt: "2026-09-19T00:00:00.000Z",
        }], nextCursor: null };
beforeEach(() => {
    mocks.cookies.clear();
    mocks.setCookie.mockReset().mockImplementation((name, value) => { mocks.cookies.set(name, value); });
    mocks.fetch.mockReset().mockRejectedValue(new Error("Unexpected upstream request"));
    vi.stubGlobal("fetch", mocks.fetch);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
function request(path = "/api/design-drafts?page=1", init?: RequestInit) {
    return new Request(`${origin}${path}`, init);
}
function upstreamHeaders() {
    return new Headers(mocks.fetch.mock.calls[0]?.[1]?.headers);
}
describe("saved-design request boundary", () => {
    it.each([undefined, "malformed-cookie"])("avoids the Worker for a newly created owner from %s", async (cookie) => {
        if (cookie !== undefined)
            mocks.cookies.set(ANONYMOUS_SESSION_COOKIE, cookie);
        const response = await GET(request());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ items: [], nextCursor: null });
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.setCookie).toHaveBeenCalledWith(ANONYMOUS_SESSION_COOKIE, expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expect.objectContaining({ httpOnly: true, secure: true, path: "/", sameSite: "lax" }));
    });
    it("reads the same owner's designs on the next request instead of caching the empty page", async () => {
        await GET(request());
        expect(mocks.fetch).not.toHaveBeenCalled();
        const cookie = mocks.cookies.get(ANONYMOUS_SESSION_COOKIE);
        if (!cookie)
            throw new Error("Missing new session cookie");
        mocks.fetch.mockResolvedValueOnce(Response.json(savedPage, { headers: { "cache-control": "public, max-age=60" } }));
        const response = await GET(request());
        expect(await response.json()).toEqual(savedPage);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(new URL("https://worker.example/v2/design-drafts?page=1"), expect.objectContaining({ method: "GET", redirect: "manual" }));
        expect(upstreamHeaders().get("x-forever-tee-owner-id")).toBe(await anonymousOwnerId(cookie));
        expect(upstreamHeaders().get("x-forever-tee-service-secret")).toBe("test-service-secret");
        expect(mocks.setCookie).toHaveBeenCalledTimes(1);
    });
    it("preserves the legacy array response for a fresh visitor", async () => {
        mocks.fetch.mockResolvedValueOnce(Response.json([]));
        const response = await GET(request("/api/design-drafts"));
        expect(await response.json()).toEqual([]);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(new URL("https://worker.example/v2/design-drafts"), expect.any(Object));
    });
    it.each([
        "/api/design-drafts?page=2", "/api/design-drafts?page=1&cursor=invalid",
        "/api/design-drafts?page=1&page=2", "/api/design-drafts?page=1&limit=0",
        "/api/design-drafts/design-id?page=1",
    ])("keeps Worker validation for %s even for a new owner", async (path) => {
        const error = { error: { code: "BAD_REQUEST", message: "Invalid request" } };
        mocks.fetch.mockResolvedValueOnce(Response.json(error, { status: 400 }));
        const response = await GET(request(path));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(error);
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(new URL(path.replace("/api/", "/v2/"), "https://worker.example"), expect.any(Object));
    });
    it("preserves same-origin, JSON-body and challenge checks on mutations", async () => {
        expect((await POST(request(undefined, { method: "POST", headers: { origin: "https://foreign.example" } }))).status).toBe(403);
        expect((await PATCH(request("/api/design-drafts/id?page=1", { method: "PATCH", headers: { origin } }))).status).toBe(415);
        expect(mocks.setCookie).not.toHaveBeenCalled();
        expect((await POST(request(undefined, { method: "POST", headers: { origin } }))).status).toBe(403);
        const upload = await POST(request("/api/design-drafts/id/upload-grants?page=1", {
            method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
        }));
        expect(upload.status).toBe(403);
        expect(await upload.json()).toMatchObject({ error: { code: "CHALLENGE_REQUIRED" } });
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
    it("forwards authenticated product-family mutations without substituting a saved-design response", async () => {
        const payload = { products: [] };
        mocks.fetch.mockResolvedValueOnce(Response.json(payload, { status: 201 }));
        const response = await configuredProductFamilyBff(request("/api/configured-product-families?page=1", {
            method: "POST", headers: { origin, "content-type": "application/json", "x-forever-tee-owner-id": "spoofed" }, body: "{}",
        }));
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual(payload);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(new URL("https://worker.example/v2/configured-product-families?page=1"), expect.objectContaining({ method: "POST", body: new TextEncoder().encode("{}").buffer }));
        const cookie = mocks.cookies.get(ANONYMOUS_SESSION_COOKIE);
        if (!cookie)
            throw new Error("Missing session cookie");
        expect(upstreamHeaders().get("x-forever-tee-owner-id")).toBe(await anonymousOwnerId(cookie));
        expect(upstreamHeaders().get("x-forever-tee-service-secret")).toBe("test-service-secret");
    });
});
describe("same-owner artwork challenge recovery", () => {
    beforeEach(() => { vi.stubEnv("TURNSTILE_TEST_MODE", "0"); });
    const grantPath = "/api/design-drafts/" + protectedConfig("resource_83abf907850d") + "/upload-grants";
    async function expiredHeaders() {
        await GET(request());
        const session = mocks.cookies.get(ANONYMOUS_SESSION_COOKIE);
        if (!session)
            throw new Error("Missing fixture session");
        const owner = await anonymousOwnerId(session);
        const expired = await createAbuseClearance(owner, "test-service-secret", Date.now() - 901000);
        return { owner, headers: { origin, "content-type": "application/json", cookie: `__Host-forever_tee_abuse=${expired}` } };
    }
    it.each([201, 409, 404])("renews verified proof for the current owner while preserving Worker status %s", async (status) => {
        const { owner, headers } = await expiredHeaders();
        mocks.fetch.mockResolvedValueOnce(Response.json({ success: true, hostname: "localhost", action: "design_processing" }))
            .mockResolvedValueOnce(Response.json({ fixture: true }, { status }));
        const response = await POST(request(grantPath, { method: "POST", headers: { ...headers, "x-turnstile-token": "fresh-proof", "x-forever-tee-owner-id": "spoofed" }, body: "{}" }));
        expect(response.status).toBe(status);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        const worker = new Headers(mocks.fetch.mock.calls[1]?.[1]?.headers);
        expect(worker.get("x-forever-tee-owner-id")).toBe(owner);
        expect(worker.has("x-turnstile-token")).toBe(false);
        const cookie = response.headers.get("set-cookie");
        if (!cookie)
            throw new Error("Missing renewed fixture clearance");
        expect(cookie).toContain("Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax");
        const renewed = new Request(origin, { headers: { cookie } });
        expect(await hasAbuseClearance(renewed, owner, "test-service-secret")).toBe(true);
        expect(await hasAbuseClearance(renewed, "another-owner", "test-service-secret")).toBe(false);
        expect(await hasAbuseClearance(renewed, owner, "test-service-secret", Date.now() + 901000)).toBe(false);
    });
    it.each([
        { success: false },
        { success: true, hostname: "foreign.example", action: "design_processing" },
        { success: true, hostname: "localhost", action: "other" },
    ])("rejects failed or mismatched proof before Worker admission: %j", async (payload) => {
        const { headers } = await expiredHeaders();
        mocks.fetch.mockResolvedValueOnce(Response.json(payload));
        const response = await POST(request(grantPath, { method: "POST", headers: { ...headers, "x-turnstile-token": "invalid-proof" }, body: "{}" }));
        expect(response.status).toBe(403);
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });
    it("keeps repeated expired requests outside Worker admission", async () => {
        const { headers } = await expiredHeaders();
        for (let attempt = 0; attempt < 3; attempt++) {
            expect((await POST(request(grantPath, { method: "POST", headers, body: "{}" }))).status).toBe(403);
        }
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
});
