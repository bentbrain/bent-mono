import { expect, test, type Response } from "@playwright/test";

import {
  addVisibleProductToCart,
  closeCart,
  selectShirtSize,
} from "./helpers";

test("a virtual camera keeps two designs in the same shirt variant separate", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/?shirtColor=White");
  // The first request trades the automation bypass header for Vercel's
  // same-origin bypass cookie. Do not leak those headers into the later
  // cross-origin Cloudflare artwork upload and its CORS preflight.
  await page.context().setExtraHTTPHeaders({});
  await selectShirtSize(page, "M");
  await addVisibleProductToCart(page);
  const originalLine = page.getByRole("dialog", { name: "Cart" })
    .getByRole("article", { name: "bent.shop", exact: true });
  // Capture the confirmed line, not its temporary optimistic merchandise image.
  await expect(originalLine.getByRole("combobox", { name: "Color for bent.shop" })).toContainText(/white/i);
  const originalThumbnail = await originalLine.locator("img").getAttribute("src");
  if (!originalThumbnail) throw new Error("Expected the original design thumbnail.");
  await closeCart(page);
  await page.getByRole("link", { name: "Make your own" }).click();

  await page.getByLabel(/I'm 18 or older/).check();
  const navigationEntries = await page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  await page.getByRole("button", { name: "Open camera" }).click();
  await expect(page).toHaveURL(/\/design\/[0-9a-f-]+\?camera=1$/, {
    timeout: 30_000,
  });
  expect(await page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  )).toBe(navigationEntries);
  const designUrl = page.url();
  const takePhoto = page.getByRole("button", { name: "Take photo in 3 seconds" });
  await expect(takePhoto).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  let uploadStartedAt = 0;
  let previewRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PUT" && path === "/v2/design-upload-grants") {
      uploadStartedAt = performance.now();
    }
    if (uploadStartedAt > 0 && path.endsWith("/artwork/preview")) previewRequests += 1;
  });
  await page.getByRole("link", { name: "create", exact: true }).click();
  await expect(page).toHaveURL(/\/create$/, { timeout: 30_000 });
  const declaration = page.getByLabel(/I'm 18 or older/);
  await expect(declaration).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Open camera" })).toBeEnabled();
  await declaration.check();
  await page.getByRole("button", { name: "Open camera" }).click();
  await expect(page).toHaveURL(/\/design\/[0-9a-f-]+\?camera=1$/, {
    timeout: 30_000,
  });
  await expect(takePhoto).toBeEnabled({ timeout: 30_000 });
  const artworkUpload = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "PUT" &&
      url.pathname === "/v2/design-upload-grants";
  }, { timeout: 45_000 });
  const revealCompleted = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/creation-trace" &&
    request.postData()?.includes('"stage":"cutout_reveal_completed"') === true,
  { timeout: 60_000 });
  const uploadTrace = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/creation-trace" &&
    request.postData()?.includes('"stage":"artwork_upload_succeeded"') === true,
  { timeout: 60_000 });
  await takePhoto.click();
  await expect(page.getByRole("region", { name: "Photo preview" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  expect(page.url()).not.toBe(designUrl);

  const uploadResponse = await artworkUpload;
  if (!uploadResponse.ok()) {
    throw new Error(await boundedUploadFailure(uploadResponse));
  }
  const uploadResult: unknown = await uploadResponse.json();
  const inlinePreview = typeof uploadResult === "object" && uploadResult !== null &&
    "preview" in uploadResult && typeof uploadResult.preview === "object";
  const uploadDurationMs = Math.round(performance.now() - uploadStartedAt);

  const continueButton = page.getByRole("button", { name: "Continue" });
  await expect(continueButton).toBeEnabled({ timeout: 60_000 });
  await revealCompleted;
  const tracePayload: unknown = (await uploadTrace).postDataJSON();
  if (typeof tracePayload !== "object" || tracePayload === null) {
    throw new Error("Expected bounded creation timings.");
  }
  const requiredPhases = ["grantDurationMs", "uploadResponseDurationMs", "responseDownloadDurationMs",
    "uploadBodyDurationMs", "portraitDurationMs", "workerDurationMs"];
  const phases = Object.fromEntries(Object.entries(tracePayload).filter(([key, value]) =>
    [...requiredPhases, "networkSetupDurationMs", "networkRequestDurationMs"].includes(key) &&
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 120_000,
  ));
  for (const field of requiredPhases) expect(phases).toHaveProperty(field);
  console.info("Creation processing timing", {
    ...phases,
    uploadDurationMs,
    readyDurationMs: Math.round(performance.now() - uploadStartedAt),
    inlinePreview,
    previewRequests,
  });
  if (inlinePreview) expect(previewRequests).toBe(0);
  const configureStartedAt = performance.now();
  await continueButton.click();
  await expect(page).toHaveURL(/\/product\/[0-9a-f-]+/i, { timeout: 45_000 });
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");

  const newProductId = new URL(page.url()).pathname.split("/").at(-1);
  if (!newProductId) throw new Error("Expected the new configured product ID.");
  const shirtColors = page.getByRole("tabpanel", { name: "t-shirt" })
    .getByRole("link", { name: /^Color:/ });
  await expect(shirtColors.first()).toHaveAttribute("aria-current", "true");
  const shirtDefault = await shirtColors.first().getAttribute("aria-label");
  expect(["Color: Black", "Color: White"]).toContain(shirtDefault);
  await selectShirtSize(page, "M");
  await page.getByRole("tab", { name: "tote" }).click();
  const toteColors = page.getByRole("tabpanel", { name: "tote" })
    .getByRole("link", { name: /^Color:/ });
  await expect(toteColors.first()).toHaveAttribute(
    "aria-label", shirtDefault === "Color: White" ? "Color: Cream" : "Color: Black",
  );
  await expect(toteColors.first()).toHaveAttribute("aria-current", "true");
  await page.getByRole("tabpanel", { name: "tote" }).getByRole("link", { name: "Color: Cream" }).click();
  await page.getByRole("tab", { name: "t-shirt" }).click();
  await expect(page.getByRole("tabpanel", { name: "t-shirt" }).getByRole("combobox", { name: "Size" })).toContainText("M");
  await page.getByRole("tabpanel", { name: "t-shirt" }).getByRole("link", { name: "Color: White" }).click();
  // Print preparation cannot delay Add to cart. Checkout retains the readiness gate.
  await expect(page.getByRole("button", { name: /Add to cart$/ })).toBeEnabled();
  const addStartedAt = performance.now();
  await addVisibleProductToCart(page);

  const cart = page.getByRole("dialog", { name: "Cart" });
  const shirts = cart.getByRole("article", { name: "bent.shop", exact: true });
  await expect(shirts).toHaveCount(2);
  const optimisticCartMs = Math.round(performance.now() - addStartedAt);
  expect(optimisticCartMs).toBeLessThan(2_000);
  for (const shirt of await shirts.all()) {
    await expect(shirt.getByRole("combobox", { name: "Color for bent.shop" })).toContainText(/white/i);
    await expect(shirt.getByRole("combobox", { name: "Size for bent.shop" })).toContainText("M");
    await expect(shirt.getByRole("group", { name: "Quantity for bent.shop: 1", exact: true })).toBeVisible();
  }
  const confirmedCartMs = Math.round(performance.now() - addStartedAt);
  const pendingArtworkAtCartConfirmation = await cart.getByRole("button", { name: "Preparing artwork…", exact: true }).count() === 1;
  // Continue now precedes full-source preparation. This wait includes that
  // background stage as well as printing; it does not delay product/cart UI.
  await expect(cart.getByRole("link", { name: "Checkout", exact: true })).toBeVisible({ timeout: 60_000 });
  console.info("New product purchase timing", {
    optimisticCartMs, confirmedCartMs, pendingArtworkAtCartConfirmation,
    configureToCheckoutReadyMs: Math.round(performance.now() - configureStartedAt),
  });
  // The accessible image is a labelled wrapper. The actual img owns the
  // configured-product URL; inspecting the wrapper would compare two nulls.
  const thumbnails = shirts.locator("img");
  await expect(thumbnails).toHaveCount(2);
  await expect.poll(async () => {
    const sources = await thumbnails.evaluateAll(elements => elements.map(element => element.getAttribute("src")));
    return {
      distinct: new Set(sources).size,
      original: sources.includes(originalThumbnail),
      created: sources.some(source => source?.includes(`/${newProductId}/white.webp`)),
    };
  }).toEqual({ distinct: 2, original: true, created: true });
  await expect.poll(() => thumbnails.evaluateAll(elements => elements.every(element =>
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  )), { timeout: 90_000 }).toBe(true);
  await expect(cart.getByText(/currently unavailable/)).toHaveCount(0);
  await expect(cart.getByRole("article")).toHaveCount(2);
  // The server must retain the new intent across a document reload and upgrade
  // it to a verified print capability before handing this cart to Shopify.
  await page.reload();
  await page.getByRole("banner").getByRole("link", { name: /^cart/i }).click();
  await expect(shirts).toHaveCount(2);
  await expect(cart.getByRole("link", { name: "Checkout", exact: true })).toBeVisible();
  const checkoutStartedAt = performance.now();
  const checkout = await page.request.get("/checkout", { maxRedirects: 0 });
  expect(checkout.status()).toBe(307);
  expect(checkout.headers()["location"]).toMatch(/^https:\/\/[^/]+\.myshopify\.com\/cart\/(?:c\/)?/);
  console.info("New product checkout handoff", { durationMs: Math.round(performance.now() - checkoutStartedAt) });
});

async function boundedUploadFailure(response: Response) {
  const payload: unknown = await response.json().catch(() => undefined);
  const code = apiErrorCode(payload) ?? "UNKNOWN";
  const screeningTiming = response.headers()["server-timing"] ?? "missing";
  const requestId = response.headers()["x-request-id"] ?? "missing";
  const retryAfter = response.headers()["retry-after"] ?? "missing";
  return `Artwork upload failed: HTTP ${String(response.status())}; code=${code}; retry-after=${retryAfter}; server-timing=${screeningTiming}; request-id=${requestId}`;
}

function apiErrorCode(payload: unknown) {
  if (
    typeof payload !== "object" || payload === null ||
    !("error" in payload) || typeof payload.error !== "object" ||
    payload.error === null || !("code" in payload.error) ||
    typeof payload.error.code !== "string"
  ) return undefined;
  return /^[A-Z0-9_]{1,64}$/.test(payload.error.code)
    ? payload.error.code
    : undefined;
}
