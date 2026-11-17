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
