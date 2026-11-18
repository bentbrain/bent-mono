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
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).display).toBe("standalone");
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
