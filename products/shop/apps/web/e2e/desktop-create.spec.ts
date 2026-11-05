import { expect, test } from "./test";

test("creation entry uses client navigation", async ({ page }) => {
  await page.goto("/?shirtColor=White");
  await expect(page).toHaveURL(/\/featured\/[^?]+\?shirtColor=White/);
  await page.waitForLoadState("load");

  let documentLoads = 0;
  page.on("load", () => {
    documentLoads += 1;
  });

  await page.getByRole("link", { name: "create", exact: true }).click();
  await expect(page).toHaveURL(/\/create$/);
  await expect(
    page.getByRole("img", { name: "QR code to continue creating this design on a phone" }),
  ).toBeVisible();
  expect(documentLoads).toBe(0);
});

for (const entry of ["/", "/?shirtColor=White", "/?shirtColor=Black"]) {
  test(`create remains reachable from ${entry}`, async ({ page }) => {
    await page.goto(entry);
    await page.getByRole("link", { name: "create", exact: true }).click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(page.getByRole("img", {
      name: "QR code to continue creating this design on a phone",
    })).toBeVisible();
  });
}

test("a short page keeps the footer at the viewport edge", async ({ page }) => {
  await page.goto("/cart");
  await expect(page.getByText("Your cart is empty.")).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    footerBottom: document.querySelector("footer")?.getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
    pageHeight: document.documentElement.scrollHeight,
  }));

  expect(dimensions.pageHeight).toBe(dimensions.viewportHeight);
  expect(dimensions.footerBottom).toBe(dimensions.viewportHeight);
});

test("desktop creation is handed to a phone without blocking shopping", async ({ page }, testInfo) => {
  await page.goto("/create");

  await expect(
    page.getByRole("img", { name: "QR code to continue creating this design on a phone" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "bent.shop" })).toHaveAttribute("href", "/");
  await expect(page.getByRole("link", { name: /^cart/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload image", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("create-desktop.png"), style: "nextjs-portal { visibility: hidden; }" });
});
