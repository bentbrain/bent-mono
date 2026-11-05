import { expect, test } from "@playwright/test";

import {
  addVisibleProductToCart,
  closeCart,
  selectShirtSize,
} from "./helpers";

test("shirt and tote remain distinct through cart mutations and checkout handoff", async ({ page }) => {
  await page.goto("/?featured=1");

  await expect(page.getByRole("tab", { name: "t-shirt" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /Choose size$/ })).toBeDisabled();
  await selectShirtSize(page, "M");
  await addVisibleProductToCart(page);
  await expect(page.getByRole("dialog", { name: "Cart" }).getByRole(
    "article",
    { name: "bent.shop" },
  )).toBeVisible();
  await closeCart(page);

  await selectShirtSize(page, "L");
  await addVisibleProductToCart(page);
  const shirtCart = page.getByRole("dialog", { name: "Cart" });
  const shirtLines = shirtCart.getByRole("article", { name: "bent.shop", exact: true });
  await expect(shirtLines).toHaveCount(2);
  const largeShirt = shirtLines.filter({ has: page.getByRole("combobox", { name: "Size for bent.shop" }).filter({ hasText: "L" }) });
  await largeShirt.getByRole("combobox", { name: "Size for bent.shop" }).click();
  await page.getByRole("option", { name: "M", exact: true }).click();
  await expect(shirtLines).toHaveCount(1);
  await expect(shirtLines.getByRole("group", { name: "Quantity for bent.shop: 2", exact: true })).toBeVisible();
  await closeCart(page);

  await page.getByRole("tab", { name: "tote" }).click();
  const totePanel = page.getByRole("tabpanel", { name: "tote" });
  await expect(totePanel.getByRole("combobox", { name: "Size" })).toHaveCount(0);
  await totePanel.getByRole("link", { name: "Color: Cream" }).click();
  await addVisibleProductToCart(page);

  const cart = page.getByRole("dialog", { name: "Cart" });
  await expect(cart.getByRole("article", { name: "bent.shop" })).toBeVisible();
  const toteLine = cart.getByRole("article", { name: "Cotton Tote" });
  await expect(toteLine).toBeVisible();
  await expect(toteLine.getByRole("combobox", { name: "Color" })).toContainText("Cream");

  let releaseMutation = () => {};
  const mutationGate = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  await page.route("**/api/cart", async (route) => {
    if (route.request().method() === "POST") await mutationGate;
    await route.continue();
  });
  await toteLine.getByRole("button", { name: "Increase quantity of Cotton Tote" }).click();
  await expect(cart.getByRole("button", { name: "Updating cart…" })).toBeVisible();
  await expect(cart.getByRole("link", { name: "Checkout" })).toHaveCount(0);
  releaseMutation();
  await expect(toteLine.getByRole("group", { name: "Quantity for Cotton Tote: 2" })).toBeVisible();
  await expect(cart.getByRole("link", { name: "Checkout" })).toBeVisible();
  await page.unroute("**/api/cart");

  await toteLine.getByRole("button", { name: "Remove" }).click();
  const removal = page.getByRole("alertdialog", { name: "Remove Cotton Tote?" });
  await expect(removal).toBeVisible();
  await removal.getByRole("button", { name: "Keep item" }).click();
  await expect(toteLine).toBeVisible();

  const checkout = await page.request.get("/checkout", { maxRedirects: 0 });
  expect([302, 307]).toContain(checkout.status());
  expect(checkout.headers()["location"]).toMatch(
    /^https:\/\/[^/]+\.myshopify\.com\/cart\/(?:c\/)?/,
  );
});
