import { expect, test } from "@playwright/test";
test("fails closed without provider configuration and serves installation assets", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Account services need setup." }),
  ).toBeVisible();
  expect(
    (
      await request.get("/api/photos/00000000-0000-4000-8000-000000000001")
    ).status(),
  ).toBe(403);
  const healthImport = await request.post("/api/health/import", {
    data: { data: { metrics: [] } },
  });
  expect(healthImport.status()).toBe(401);
  expect(healthImport.headers()["cache-control"]).toContain("no-store");
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).display).toBe("standalone");
});

test("keeps iPhone sync routes closed without provider configuration", async ({
  request,
}) => {
  const ready = await request.get("/api/health/devices/ready");
  expect(ready.status()).toBe(503);
  expect(ready.headers()["cache-control"]).toContain("no-store");
  expect(await ready.json()).toMatchObject({ code: "enrollment_unavailable" });
  const bearerless: Record<string, string> = {};
  for (const headers of [
    bearerless,
    { Authorization: "Bearer oat_synthetic" },
  ]) {
    const enroll = await request.post("/api/health/devices", {
      headers,
      data: { installationId: crypto.randomUUID(), deviceName: "iPhone" },
    });
    expect(enroll.status()).toBe(503);
    expect(enroll.headers()["cache-control"]).toContain("no-store");
    expect(await enroll.json()).toMatchObject({
      code: "enrollment_unavailable",
    });
  }
  const disconnect = await request.delete("/api/health/devices/current", {
    headers: { Authorization: "Bearer ak_synthetic" },
  });
  expect(disconnect.status()).toBe(503);
  expect(await disconnect.json()).toMatchObject({ code: "auth_unavailable" });
  const healthImport = await request.post("/api/health/import", {
    headers: { Authorization: "Bearer ak_synthetic" },
    data: { data: { metrics: [] } },
  });
  expect(healthImport.status()).toBe(401);
  expect(await healthImport.json()).toMatchObject({ code: "unauthorized" });
});

test("serves the ten multi-angle exercise illustrations and their thumbnails", async ({
  request,
}) => {
  for (const exercise of [
    "squat",
    "bench",
    "row",
    "rdl",
    "raise",
    "plank",
    "split",
    "incline",
    "press",
    "curl",
  ]) {
    const response = await request.get(`/exercise-guides/${exercise}.png`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
    expect((await response.body()).subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    const thumb = await request.get(`/exercise-guides/thumbs/${exercise}.jpg`);
    expect(thumb.status()).toBe(200);
    expect(thumb.headers()["content-type"]).toContain("image/jpeg");
    expect((await thumb.body()).byteLength).toBeLessThan(60000);
  }
});
