import { expect, test } from "./test";

test("local Shopify consent initializes without a browser error", async ({ page }) => {
  const consentErrors: string[] = [];
  page.on("console", message => {
    if (message.type() === "error" && message.text().startsWith("[hydrogen:error:Consent]")) {
      consentErrors.push(message.text());
    }
  });

  await page.goto("/create");
  await expect.poll(() => page.evaluate(() => window.Shopify?.customerPrivacy?.consentStatus)).toBe("loaded");
  expect(consentErrors).toEqual([]);
});

test("mobile creation requires explicit consent before opening the camera", async ({ page }) => {
  await page.goto("/create");
  const consent = page.getByRole("checkbox");
  await expect(consent).not.toBeChecked();
  await page.getByRole("button", { name: "Open camera", exact: true }).click();
  await expect(page).toHaveURL(/\/create$/);
  expect(await consent.evaluate(element => element.matches(":invalid"))).toBe(true);
  await consent.check();
  await expect(page.getByRole("button", { name: "Open camera", exact: true })).toBeEnabled();
  expect(await consent.evaluate(element => element.matches(":valid"))).toBe(true);
});
