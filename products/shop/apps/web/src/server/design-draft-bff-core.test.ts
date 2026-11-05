import { describe, expect, it } from "vitest";

import {
  abuseClearanceCookie,
  acceptsSameOriginMutation,
  createAbuseClearance,
  declaredMutationLength,
  hasAbuseClearance,
  hasJsonContentType,
  MAX_BFF_JSON_BYTES,
  matchesDeclaredLength,
  readMutationBody,
  requiresJsonMutation,
  TURNSTILE_ACTION,
  DEVELOPMENT_TURNSTILE_HOSTNAMES,
  PRODUCTION_TURNSTILE_HOSTNAMES,
  turnstileHostnamesForEnvironment,
  turnstileTestMode,
  validateMutationBody,
  verifyTurnstileToken,
  workerHeaders,
  forwardedWorkerHeaders,
} from "./design-draft-bff-core";

describe("design draft BFF boundary", () => {
  it("accepts same-origin mutations and rejects missing or foreign origins", () => {
    expect(acceptsSameOriginMutation(new Request("https://shop.bent.build/api/design-drafts", {
      method: "POST",
      headers: { origin: "https://shop.bent.build" },
    }))).toBe(true);
    expect(acceptsSameOriginMutation(new Request("https://shop.bent.build/api/design-drafts", {
      method: "POST",
    }))).toBe(false);
    expect(acceptsSameOriginMutation(new Request("https://shop.bent.build/api/design-drafts", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }))).toBe(false);
  });

  it("adds server-owned identity, service authentication, and correlation headers", () => {
    const headers = workerHeaders(
      new Request("https://shop.bent.build/api/design-drafts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
      }),
      "a".repeat(64),
      "shared-secret",
      "request-123",
    );
    expect(headers.get("x-forever-tee-owner-id")).toBe("a".repeat(64));
    expect(headers.get("x-forever-tee-service-secret")).toBe("shared-secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-id")).toBe("request-123");
  });

  it("forwards bounded diagnostic response headers to the browser", () => {
    const headers = forwardedWorkerHeaders(new Response(null, {
      headers: {
        "content-type": "application/json",
        "retry-after": "60",
        "server-timing": "worker;dur=42",
        "x-request-id": "request-123",
        "x-secret": "must-not-leak",
      },
    }));

    expect(Object.fromEntries(headers)).toEqual({
      "cache-control": "private, no-store",
      "content-type": "application/json",
      "retry-after": "60",
      "server-timing": "worker;dur=42",
      "x-request-id": "request-123",
    });
  });

  it("accepts only successful Turnstile responses for the expected action and host", async () => {
    const siteverify = (payload: object) => () => Promise.resolve(Response.json(payload));
    const valid = {
      action: TURNSTILE_ACTION,
      hostname: "forever-tee-web.vercel.app",
      success: true,
    };
    const verify = (payload: object) => verifyTurnstileToken(
      "token",
      "secret",
      undefined,
      siteverify(payload),
      PRODUCTION_TURNSTILE_HOSTNAMES,
      false,
    );
    expect(await verifyTurnstileToken("token", "secret", "192.0.2.1", siteverify(valid), PRODUCTION_TURNSTILE_HOSTNAMES, false)).toBe(true);
    for (const hostname of PRODUCTION_TURNSTILE_HOSTNAMES) {
      expect(await verifyTurnstileToken(
        "token",
        "secret",
        undefined,
        siteverify({ ...valid, hostname }),
        PRODUCTION_TURNSTILE_HOSTNAMES,
        false,
      )).toBe(true);
    }
    expect(await verify({ ...valid, action: "login" })).toBe(false);
    expect(await verify({ ...valid, hostname: "attacker.example" })).toBe(false);
    expect(await verify({ ...valid, hostname: "feature-branch.vercel.app" })).toBe(false);
    expect(await verify({ ...valid, success: false })).toBe(false);
    expect(await verifyTurnstileToken(null, "secret", undefined, siteverify(valid), PRODUCTION_TURNSTILE_HOSTNAMES, false)).toBe(false);
  });

  it("uses localhost-only Turnstile hosts outside production", () => {
    expect([...PRODUCTION_TURNSTILE_HOSTNAMES]).toEqual([
      "forever-tee-web.vercel.app",
      "shop.bent.build",
    ]);
    expect(turnstileHostnamesForEnvironment("production")).toBe(PRODUCTION_TURNSTILE_HOSTNAMES);
    expect(turnstileHostnamesForEnvironment("development")).toBe(DEVELOPMENT_TURNSTILE_HOSTNAMES);
    expect(DEVELOPMENT_TURNSTILE_HOSTNAMES.has("localhost")).toBe(true);
    expect(DEVELOPMENT_TURNSTILE_HOSTNAMES.has("shop.bent.build")).toBe(false);
  });

  it("accepts only Cloudflare's live-shaped dummy response in non-production test mode", async () => {
    const siteverify = (payload: object) => () => Promise.resolve(Response.json(payload));
    const dummy = { success: true, hostname: "example.com" };
    const enabled = turnstileTestMode("development", undefined, "1");
    expect(enabled).toBe(true);
    expect(await verifyTurnstileToken(
      "dummy-token",
      "dummy-secret",
      undefined,
      siteverify(dummy),
      DEVELOPMENT_TURNSTILE_HOSTNAMES,
      enabled,
    )).toBe(true);
    expect(await verifyTurnstileToken(
      "dummy-token",
      "dummy-secret",
      undefined,
      siteverify({ ...dummy, action: TURNSTILE_ACTION }),
      DEVELOPMENT_TURNSTILE_HOSTNAMES,
      enabled,
    )).toBe(false);
  });

  it("cannot enable dummy Turnstile semantics in production", async () => {
    const siteverify = () => Promise.resolve(Response.json({
      success: true,
      hostname: "example.com",
    }));
    const enabled = turnstileTestMode("production", "production", "1");
    expect(enabled).toBe(false);
    expect(await verifyTurnstileToken(
      "dummy-token",
      "production-secret",
      undefined,
      siteverify,
      PRODUCTION_TURNSTILE_HOSTNAMES,
      enabled,
    )).toBe(false);
  });

  it("allows dummy Turnstile semantics in a Vercel Preview production build", () => {
    expect(turnstileTestMode("production", "preview", "1")).toBe(true);
    expect(turnstileTestMode("production", "preview", undefined)).toBe(false);
    expect(turnstileTestMode("production", "production", "1")).toBe(false);
  });

  it("binds a short-lived signed clearance to the anonymous owner", async () => {
    const now = 1_800_000_000_000;
    const clearance = await createAbuseClearance("owner-a", "secret", now);
    const request = new Request("https://shop.bent.build", {
      headers: { cookie: `__Host-forever_tee_abuse=${clearance}` },
    });
    expect(await hasAbuseClearance(request, "owner-a", "secret", now)).toBe(true);
    expect(await hasAbuseClearance(request, "owner-b", "secret", now)).toBe(false);
    expect(await hasAbuseClearance(request, "owner-a", "secret", now + 15 * 60 * 1_000)).toBe(false);
    expect(abuseClearanceCookie(clearance)).toContain("HttpOnly; Secure; SameSite=Lax");
  });

  it("requires JSON metadata for body-bearing capability mutations", () => {
    const request = new Request("https://shop.bent.build/api/configured-products", {
      method: "POST",
      headers: {
        "content-length": "2",
        "content-type": "application/json; charset=utf-8",
      },
      body: "{}",
    });
    expect(requiresJsonMutation(request)).toBe(true);
    expect(hasJsonContentType(request)).toBe(true);
    expect(declaredMutationLength(request)).toBe(2);
    expect(hasJsonContentType(new Request(request.url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
    }))).toBe(false);
  });

  it("rejects invalid declared lengths and caps the bytes actually read", async () => {
    const invalid = new Request("https://shop.bent.build/api/configured-products", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
    });
    expect(declaredMutationLength(invalid)).toBeNaN();
    const oversized = new Request("https://shop.bent.build/api/configured-products", {
      method: "POST",
      body: new Uint8Array(MAX_BFF_JSON_BYTES + 1),
    });
    expect(await readMutationBody(oversized, MAX_BFF_JSON_BYTES)).toBeUndefined();
    expect(matchesDeclaredLength(2, new Uint8Array(3))).toBe(false);
    expect(matchesDeclaredLength(3, new Uint8Array(3))).toBe(true);
  });

  it("accepts upload-grant JSON without a browser-supplied Content-Length", async () => {
    const body = JSON.stringify({ contentType: "image/jpeg", expectedVersion: 0, maxBytes: 12345 });
    const request = new Request("https://shop.bent.build/api/design-drafts/draft-1/upload-grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(request.headers.has("content-length")).toBe(false);
    expect(await validateMutationBody(request)).toEqual({
      ok: true,
      body: new TextEncoder().encode(body),
    });
  });

  it("returns bounded BFF failures before forwarding malformed JSON", async () => {
    const wrongType = await validateMutationBody(new Request(
      "https://shop.bent.build/api/configured-products",
      {
        method: "POST",
        headers: { "content-length": "2", "content-type": "text/plain" },
        body: "{}",
      },
    ));
    expect(wrongType).toMatchObject({ ok: false, status: 415 });
    const missingLength = await validateMutationBody(new Request(
      "https://shop.bent.build/api/configured-products",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ));
    expect(missingLength).toEqual({ ok: true, body: new TextEncoder().encode("{}") });
    const mismatched = await validateMutationBody(new Request(
      "https://shop.bent.build/api/configured-products",
      {
        method: "POST",
        headers: { "content-length": "1", "content-type": "application/json" },
        body: "{}",
      },
    ));
    expect(mismatched).toMatchObject({ ok: false, status: 400 });
  });

  it.each([
    { method: "POST", path: "/api/design-drafts/draft-1/upload-grants" },
    { method: "PATCH", path: "/api/design-drafts/draft-1" },
    { method: "POST", path: "/api/configured-products" },
    { method: "POST", path: "/api/configured-product-families" },
  ])("bounds actual JSON bytes without Content-Length for $method $path", async ({ method, path }) => {
    const request = (body: string) => new Request(`https://shop.bent.build${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body,
    });
    const boundaryBody = JSON.stringify("a".repeat(MAX_BFF_JSON_BYTES - 2));
    expect(await validateMutationBody(request(boundaryBody))).toMatchObject({ ok: true });
    expect(await validateMutationBody(request(boundaryBody + " "))).toMatchObject({ ok: false, status: 413 });
    expect(await validateMutationBody(request(""))).toMatchObject({ ok: false, status: 400 });
  });

  it.each(["not-a-number", "0", "-1", "1.5", "9007199254740992"])("still rejects invalid declared length %s", async (length) => {
    const request = new Request("https://shop.bent.build/api/design-drafts/draft-1/upload-grants", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": length },
      body: "{}",
    });
    expect(await validateMutationBody(request)).toMatchObject({ ok: false, status: 411 });
  });
});
