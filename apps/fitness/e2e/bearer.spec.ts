import { expect, test } from "@playwright/test";

// This server has synthetic Clerk keys and reaches no Clerk service. The
// session middleware marks each response it handles with x-clerk-auth-status
// and answers a browser page load with a sign-in handshake. Bearer routes
// skip it and answer with their own JSON.
const cookie = "__session=eyJhbGciOiJSUzI1NiJ9.e30.x; __client_uat=1700000000";
// Clerk hands browser page loads, not API calls, to its sign-in handshake.
const browser = {
  Cookie: cookie,
  "Sec-Fetch-Dest": "document",
  Accept: "text/html",
};

test("answers bearer routes with their own JSON, never a session handshake", async ({
  request,
}) => {
  const cases = [
    {
      method: "POST",
      path: "/api/health/import",
      data: { data: { metrics: [] } },
      status: 503,
      code: "auth_unavailable",
    },
    {
      method: "POST",
      path: "/api/health/devices",
      data: { installationId: crypto.randomUUID(), deviceName: "iPhone" },
      status: 503,
      code: "enrollment_unavailable",
    },
    {
      method: "DELETE",
      path: "/api/health/devices/current",
      status: 503,
      code: "auth_unavailable",
    },
  ];
  for (const { method, path, data, status, code } of cases)
    for (const headers of [
      { Authorization: "Bearer ak_synthetic", ...browser },
      { Authorization: "Bearer ak_synthetic" },
    ]) {
      const response = await request.fetch(path, {
        method,
        headers,
        data,
        maxRedirects: 0,
      });
      expect({ path, status: response.status() }).toEqual({ path, status });
      expect(response.headers()["location"]).toBeUndefined();
      expect(response.headers()["x-clerk-auth-status"]).toBeUndefined();
      expect(response.headers()["content-type"]).toContain("application/json");
      expect(await response.json()).toMatchObject({ code });
    }
  for (const path of [
    "/api/health/import",
    "/api/health/devices",
    "/api/health/devices/current",
  ]) {
    const page = await request.get(path, { headers: browser, maxRedirects: 0 });
    expect({ path, status: page.status() }).not.toEqual({ path, status: 307 });
    expect(page.headers()["x-clerk-auth-status"]).toBeUndefined();
  }
  // The session middleware still handles pages.
  const home = await request.get("/", { headers: browser, maxRedirects: 0 });
  expect(home.headers()["x-clerk-auth-status"]).toBe("handshake");
});

test("keeps the import's legacy 401 for a missing bearer", async ({
  request,
}) => {
  const response = await request.post("/api/health/import", {
    headers: browser,
    data: { data: { metrics: [] } },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["x-clerk-auth-status"]).toBeUndefined();
  expect(response.headers()["www-authenticate"]).toBe(
    'Bearer error="invalid_token"',
  );
  expect(await response.json()).toEqual({
    error: "Send a Fitness API key as the bearer token.",
    code: "unauthorized",
  });
});
