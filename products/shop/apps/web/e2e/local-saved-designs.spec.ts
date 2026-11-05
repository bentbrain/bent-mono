import { expect, test } from "./test";

test("saved designs load in requested pages and recover without losing the grid", async ({ page, request }, testInfo) => {
  const productId = "4c22bf7e-e698-4a0a-90c4-66c5549f1c45";
  // Compile the fixture route before timing a user navigation on a fresh dev server.
  await expect(await request.get(`/product/${productId}`)).toBeOK();
  const items = Array.from({ length: 85 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    productId, color: "White", createdAt: "2026-09-09T00:00:00.000Z",
  }));
  const requests: (string | null)[] = [];
  const pending = Promise.withResolvers<void>();
  await page.route("**/api/design-drafts?*", async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("page")).toBe("1");
    const cursor = url.searchParams.get("cursor");
    requests.push(cursor);
    if (requests.length === 2) {
      await pending.promise;
      return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Try again." } } });
    }
    const start = cursor === null ? 0 : cursor.endsWith(items[39]?.id ?? "missing") ? 40 : 80;
    const batch = items.slice(start, start + 40);
    const last = batch.at(-1);
    return route.fulfill({ json: { items: batch,
      nextCursor: start + 40 < items.length && last ? `v1.1700000000000.${last.id}` : null } });
  });
  await page.goto("/");
  const gallery = page.getByRole("region", { name: "Products", exact: true });
  const links = gallery.getByRole("link", { name: /Open saved design/ });
  await expect(links).toHaveCount(40);
  const grid = gallery.locator(".grid").first();
  expect(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(3);
  await expect(gallery.getByRole("button", { name: "Load more" })).toBeVisible();
  expect(requests).toEqual([null]);
  await expect.poll(() => gallery.locator("img").first().evaluate(image =>
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("saved-designs-first-page.png"), fullPage: true, animations: "disabled" });
  await gallery.getByRole("button", { name: "Load more" }).focus();
  await page.keyboard.press("Enter");
  await expect(gallery.getByRole("button", { name: "Loading…" })).toBeDisabled();
  await expect(links).toHaveCount(40);
  pending.resolve();
  await expect(gallery.getByRole("alert")).toContainText("More designs");
  await gallery.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  await expect(links).toHaveCount(80);
  await expect(gallery.getByRole("link", { name: "Open saved design 41", exact: true })).toBeFocused();
  expect(requests[1]).toBe(requests[2]);
  await gallery.getByRole("button", { name: "Load more" }).focus();
  await page.keyboard.press("Enter");
  await expect(links).toHaveCount(85);
  await expect(gallery.getByRole("button")).toHaveCount(0);
  const lastPage = gallery.getByRole("link", { name: "Open saved design 81", exact: true });
  await expect(lastPage).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("saved-designs-last-page.png"), fullPage: true, animations: "disabled" });
  await lastPage.click();
  await expect(page).toHaveURL(new RegExp(`/product/${productId}`));
  await expect(page.getByRole("tab", { name: "t-shirt", exact: true })).toBeVisible();
  await page.goBack();
  await expect(links).toHaveCount(40);
  expect(requests).toHaveLength(5);
  expect(requests.at(-1)).toBeNull();
});
