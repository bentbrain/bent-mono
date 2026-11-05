import { expect, type Page } from "@playwright/test";

export async function selectShirtSize(page: Page, size: string) {
  const sizeSelect = page.getByRole("combobox", { name: "Size" });
  await sizeSelect.click();
  await page.getByRole("option", { exact: true, name: size }).click();
  await expect(sizeSelect).toContainText(size);
}

export async function addVisibleProductToCart(page: Page) {
  const addButton = page.getByRole("button", { name: /Add to cart$/ });
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(page.getByRole("dialog", { name: "Cart" })).toBeVisible();
}

export async function closeCart(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Cart" })).toBeHidden();
}
