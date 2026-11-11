import {expect, test} from "./test";
const capability = "a".repeat(43);
test("private order link reads safely and allows repeated address corrections", async ({page}) => {
  const writes: string[] = [], externalScripts: string[] = [];
  page.on("request", request => {
    if (request.url().includes("/api/manage-order") && request.method() === "POST") writes.push(request.postData() ?? "");
    if (request.resourceType() === "script" && new URL(request.url()).hostname === "cdn.shopify.com") externalScripts.push(request.url());
  });
  await page.goto(`/manage-order#${capability}`);
  await expect(page.getByRole("heading", {name: "Order #LOCAL-1001"})).toBeVisible();
  await expect(page.getByLabel("Address", {exact: true})).toHaveValue("1 Queen Street");
  expect(writes).toHaveLength(0);
  expect(externalScripts).toHaveLength(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await page.getByLabel("Address", {exact: true}).fill("20 Queen Street");
  await page.getByRole("button", {name: "SAVE ADDRESS", exact: true}).click();
  await expect(page.getByRole("status")).toHaveText("Address saved. The original correction deadline still applies.");
  await page.getByLabel("Address", {exact: true}).fill("30 Queen Street");
  await page.getByRole("button", {name: "SAVE ADDRESS", exact: true}).click();
  await expect(page.getByRole("status")).toHaveText("Address saved. The original correction deadline still applies.");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toContain("30 Queen Street");
});
test("cancellation requires an explicit whole-order confirmation", async ({page}) => {
  const writes: string[] = [];
  page.on("request", request => {if (request.url().includes("/api/manage-order") && request.method() === "POST") writes.push(request.postData() ?? "");});
  await page.goto(`/manage-order#${capability}`);
  await page.getByRole("button", {name: "CANCEL ORDER", exact: true}).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", {name: "Keep order", exact: true}).click();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", {name: "CANCEL ORDER", exact: true}).click();
  await page.getByRole("button", {name: "CANCEL AND REFUND", exact: true}).click();
  await expect(page.getByRole("status")).toContainText("Cancellation and a full refund have been requested");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('"confirmation":"CANCEL AND REFUND"');
  await expect(page.getByRole("button", {name: "SAVE ADDRESS", exact: true})).toHaveCount(0);
});
test("expired and malformed links offer support without exposing an address", async ({page}) => {
  await page.goto(`/manage-order#${"z".repeat(43)}`);
  await expect(page.getByRole("status")).toContainText("correction window has closed");
  await expect(page.getByLabel("Address", {exact: true})).toHaveCount(0);
  await page.goto("/manage-order#bad");
  await expect(page.getByRole("status")).toContainText("Open the Manage order link");
  await expect(page.getByRole("link", {name: "support@bent.build"})).toBeVisible();
});

test("manage order heading clears the shared header", async ({page}) => {
  await page.goto("/manage-order#bad");
  const header = await page.getByRole("banner").boundingBox();
  const heading = await page.getByRole("heading", {name: "Manage order", exact: true}).boundingBox();
  if (!header || !heading) throw new Error("Order page layout is missing");
  expect(heading.y - (header.y + header.height)).toBeGreaterThanOrEqual(32);
});
