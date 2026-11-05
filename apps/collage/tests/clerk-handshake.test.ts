import "./env";

import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { NextFetchEvent } from "next/dist/server/web/spec-extension/fetch-event.js";

const { default: proxy } = await import("../src/proxy");

async function requestThroughProxy(url: string, hasClientCookie = false) {
  const request = new NextRequest(url, {
    headers: {
      accept: new URL(url).pathname.startsWith("/api/")
        ? "application/json"
        : "text/html",
      "sec-fetch-dest": new URL(url).pathname.startsWith("/api/")
        ? "empty"
        : "document",
      ...(hasClientCookie
        ? { cookie: `__client_uat=${Math.floor(Date.now() / 1000)}` }
        : {}),
    },
  });
  const event = new NextFetchEvent({
    request,
    page: "/proxy",
    context: undefined,
  });
  const response = await proxy(request, event);
  assert.ok(response instanceof Response);
  return response;
}

for (const origin of [
  "https://maya-collage.bent.build",
  "https://maya-collage-preview.vercel.app",
]) {
  for (const path of ["/", "/sign-in", "/create"]) {
    await test(`${origin}${path} refreshes existing clients through the registered Clerk frontend`, async () => {
      const url = `${origin}${path}`;
      const response = await requestThroughProxy(url, true);
      assert.equal(response.status, 307);
      const location = response.headers.get("location");
      assert.ok(location);
      const handshake = new URL(location);
      assert.equal(handshake.hostname, "clerk.maya-collage.bent.build");
      assert.equal(handshake.pathname, "/v1/client/handshake");
      assert.equal(handshake.searchParams.get("redirect_url"), url);
      assert.equal(
        handshake.searchParams.get("__clerk_hs_reason"),
        "client-uat-but-no-session-token",
      );
    });
  }
}

for (const hasClientCookie of [false, true]) {
  await test(`legacy app host redirects before authentication with client cookie ${hasClientCookie}`, async () => {
    const response = await requestThroughProxy(
      "https://maya-collage.vercel.app/create?source=bookmark",
      hasClientCookie,
    );
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://maya-collage.bent.build/create?source=bookmark",
    );
  });
}

for (const path of ["/", "/sign-in", "/user_fixture", "/privacy-policy"]) {
  await test(`anonymous public route ${path} remains accessible`, async () => {
    const response = await requestThroughProxy(
      `https://maya-collage.bent.build${path}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
  });
}

await test("anonymous create page still requires sign-in", async () => {
  const response = await requestThroughProxy(
    "https://maya-collage.bent.build/create",
  );
  assert.equal(response.status, 307);
  const location = response.headers.get("location");
  assert.ok(location);
  const signIn = new URL(location);
  assert.equal(signIn.hostname, "maya-collage.bent.build");
  assert.equal(signIn.pathname, "/sign-in");
  assert.equal(
    signIn.searchParams.get("redirect_url"),
    "https://maya-collage.bent.build/create",
  );
});

await test("anonymous protected API still rejects access", async () => {
  const response = await requestThroughProxy(
    "https://maya-collage.bent.build/api/trpc/collage.getAll",
  );
  // Clerk hides protected resources behind an internal not-found rewrite.
  const rewrite = response.headers.get("x-middleware-rewrite");
  assert.ok(rewrite);
  assert.match(new URL(rewrite).pathname, /^\/clerk_\d+$/);
  assert.equal(response.headers.get("location"), null);
});
