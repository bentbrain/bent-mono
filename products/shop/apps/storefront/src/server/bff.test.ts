import { test } from "node:test";
import assert from "node:assert/strict";
import { createBff } from "./bff.ts";
import { anonymousOwnerId } from "../../../web/src/server/anonymous-session-core.ts";
import { signContentDeclaration } from "../../../web/src/server/content-declaration-core.ts";

const secret = "synthetic-service-secret-000000000000";
const origin = "https://shop.bent.build";
const token = "a".repeat(43);
const product = "f0584c5e-0583-453a-8f85-4fb53faabbd8";
async function ownerCookie() {
  return `__Host-forever_tee_session=${token}; __Host-bent_shirt_declaration=${await signContentDeclaration(await anonymousOwnerId(token), secret)}`;
}
function runtime(fetcher: typeof fetch) {
  return createBff({
    apiOrigin: "https://api.example.invalid",
    sharedSecret: secret,
    turnstileSecret: "synthetic-turnstile-secret",
    fetcher,
  });
}
function request(path: string, init: RequestInit = {}) {
  return new Request(`${origin}${path}`, init);
}

await test("refuses cross-origin writes and consent-free draft creation before provider work", async () => {
  let calls = 0;
  const handler = runtime(() => {
    calls++;
    throw new Error("Unexpected provider work");
  });
  assert.equal(
    (
      await handler(
        request("/api/design-drafts", {
          method: "POST",
          headers: { origin: "https://foreign.invalid" },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handler(
        request("/api/design-drafts", { method: "POST", headers: { origin } }),
      )
    ).status,
    403,
  );
  assert.equal(calls, 0);
});

await test("declaration issues independent secure owner and signed declaration cookies", async () => {
  const handler = runtime(() => {
    throw new Error("Unexpected provider work");
  });
  const response = await handler(
    request("/api/content-declaration", {
      method: "POST",
      headers: {
        origin,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "contentDeclaration=accepted",
    }),
  );
  assert.equal(response.status, 204);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const cookie of cookies)
    assert.match(cookie, /Path=\/; HttpOnly; Secure; SameSite=Lax/);
  assert.ok(
    cookies.some((value) => value.startsWith("__Host-forever_tee_session=")),
  );
  assert.ok(
    cookies.some((value) =>
      value.startsWith("__Host-bent_shirt_declaration=portrait-v1."),
    ),
  );
});

await test("forwards owner digest, strips browser credentials, validates challenge action and preserves clearance", async () => {
  const cookie = await ownerCookie();
  let observed: Request | undefined;
  const handler = runtime((input, init) => {
    const upstream = new Request(input, init);
    if (new URL(upstream.url).hostname === "challenges.cloudflare.com")
      return Promise.resolve(
        Response.json({
          success: true,
          hostname: "shop.bent.build",
          action: "design_processing",
        }),
      );
    observed = upstream;
    return Promise.resolve(
      Response.json(
        { id: product },
        { status: 201, headers: { "x-request-id": "synthetic-request" } },
      ),
    );
  });
  const response = await handler(
    request("/api/design-drafts", {
      method: "POST",
      headers: {
        origin,
        cookie,
        authorization: "browser-forgery",
        "x-forever-tee-owner-id": "forged",
        "x-turnstile-token": "synthetic-token",
      },
    }),
  );
  assert.equal(response.status, 201);
  assert.ok(observed);
  assert.equal(
    observed.headers.get("x-forever-tee-owner-id"),
    await anonymousOwnerId(token),
  );
  assert.equal(observed.headers.get("cookie"), null);
  assert.equal(observed.headers.get("authorization"), null);
  assert.equal(observed.headers.get("x-forever-tee-service-secret"), secret);
  assert.match(
    response.headers.getSetCookie()[0] ?? "",
    /^__Host-forever_tee_abuse=/,
  );
});

await test("rejects invalid JSON content types and actual oversized bodies before forwarding", async () => {
  let calls = 0;
  const handler = runtime(() => {
    calls++;
    throw new Error("Unexpected provider work");
  });
  for (const [contentType, body, expected] of [
    ["text/plain", "{}", 415],
    ["application/json", "x".repeat(16_385), 413],
  ]) {
    const response = await handler(
      request("/api/configured-product-families", {
        method: "POST",
        headers: { origin, "content-type": String(contentType) },
        body: String(body),
      }),
    );
    assert.equal(response.status, expected);
  }
  assert.equal(calls, 0);
});

await test("preserves pending media, ready bytes, HEAD metadata and private cache policy", async () => {
  let ready = false;
  const handler = runtime((input, init) => {
    const upstream = new Request(input, init);
    assert.equal(upstream.headers.get("x-forever-tee-service-secret"), secret);
    assert.equal(
      new URL(upstream.url).pathname,
      `/v2/internal/configured-products/${product}/images/flat/black`,
    );
    if (!ready)
      return Promise.resolve(
        new Response(null, {
          status: 202,
          headers: { "retry-after": "1" },
        }),
      );
    return Promise.resolve(
      new Response(
        upstream.method === "HEAD" ? null : new Uint8Array([1, 2, 3]),
        {
          headers: {
            "content-type": "image/webp",
            "content-length": "3",
            etag: "synthetic-etag",
          },
        },
      ),
    );
  });
  const path = `/api/configured-product-image/current/${product}/black.webp?width=384`;
  const pending = await handler(request(path));
  assert.equal(pending.status, 202);
  assert.equal(pending.headers.get("retry-after"), "1");
  ready = true;
  const response = await handler(request(path));
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const head = await handler(request(path, { method: "HEAD" }));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get("content-length"), "3");
  assert.equal(
    (await handler(request(path.replace("384", "385")))).status,
    400,
  );
});

await test("streams events without buffering and carries abort upstream", async () => {
  const abort = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  const handler = runtime((_input, init) => {
    upstreamSignal = init?.signal;
    return Promise.resolve(
      new Response('data: {"status":"pending"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  });
  const response = await handler(
    request(`/api/configured-product-video/${product}/events`, {
      signal: abort.signal,
    }),
  );
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, no-transform",
  );
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.match(await response.text(), /pending/);
  abort.abort();
  assert.equal(upstreamSignal?.aborted, true);
});

// A Host header must not authorize an arbitrary Turnstile hostname.
await test("rejects a successful challenge issued for an unapproved hostname", async () => {
  let providerCalls = 0;
  const handler = runtime((input, init) => {
    if (
      new URL(new Request(input, init).url).hostname ===
      "challenges.cloudflare.com"
    )
      return Promise.resolve(
        Response.json({
          success: true,
          hostname: "foreign.invalid",
          action: "design_processing",
        }),
      );
    providerCalls++;
    return Promise.resolve(Response.json({ id: product }));
  });
  const response = await handler(
    new Request("https://foreign.invalid/api/design-drafts", {
      method: "POST",
      headers: {
        origin: "https://foreign.invalid",
        cookie: await ownerCookie(),
        "x-turnstile-token": "synthetic-token",
      },
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(providerCalls, 0);
});

await test("enforces supported source MIME types and the actual 20 MB upload body bound", async () => {
  let calls = 0;
  const handler = runtime(() => {
    calls++;
    throw new Error("Unexpected provider call");
  });
  const unsupported = await handler(
    request("/api/design-upload-grants?grant=synthetic", {
      method: "PUT",
      headers: { origin, "content-type": "image/gif" },
      body: new Uint8Array([1]),
    }),
  );
  assert.equal(unsupported.status, 415);
  const oversized = await handler(
    request("/api/design-upload-grants?grant=synthetic", {
      method: "PUT",
      headers: { origin, "content-type": "image/png" },
      body: new Uint8Array(20_000_001),
    }),
  );
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
});
