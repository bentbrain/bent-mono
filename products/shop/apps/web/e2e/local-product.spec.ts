import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test";
import { selectShirtSize } from "./helpers";

for (const width of [390, 1440]) {
  test(`malformed product links use the existing not-found page at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/product/not-a-product");
    await expect(page.getByRole("heading", { name: "Page not found.", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "We couldn't load this page.", exact: true })).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /\bnoindex\b/);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`malformed-product-${width}.png`) });
    await page.getByRole("link", { name: "Go home", exact: true }).click();
    await expect(page.getByRole("heading", { name: "bent.shop products", exact: true })).toBeVisible();
  });
}

test.describe("touch colour activation", () => {
  test.use({ hasTouch: true });

  test("colour selection survives missing compatibility clicks and ignores stale ones", async ({ page }) => {
    // The phone trace delivers touch release promptly but delays or drops its
    // compatibility click. Exercise that boundary with the actual product UI.
    await page.addInitScript(() => {
      window.addEventListener("click", event => {
        if (event.isTrusted && event.target instanceof Element &&
          event.target.closest('a[aria-label^="Color:"]')) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    });
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M");
    await expect(page.getByRole("tab", { name: "t-shirt", exact: true })).not.toHaveAttribute("aria-disabled", "true");
    const shirt = page.getByRole("tabpanel", { name: "t-shirt", exact: true });
    const black = shirt.getByRole("link", { name: "Color: Black", exact: true });
    const white = shirt.getByRole("link", { name: "Color: White", exact: true });
    for (let index = 0; index < 10; index++) {
      const link = index % 2 ? white : black;
      await link.tap();
      await expect(link).toHaveAttribute("aria-current", "true", { timeout: 1000 });
    }
    await black.evaluate(link => link.dispatchEvent(new PointerEvent("click", {
      bubbles: true, cancelable: true, pointerType: "touch", detail: 1,
    })));
    await expect(white).toHaveAttribute("aria-current", "true");
    await expect(page).toHaveURL(/Color=White/);
  });

  test("colour gestures wait for release and preserve cancellation, mouse and keyboard choices", async ({ page }) => {
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M");
    await expect(page.getByRole("tab", { name: "t-shirt", exact: true })).not.toHaveAttribute("aria-disabled", "true");
    const shirt = page.getByRole("tabpanel", { name: "t-shirt", exact: true });
    const black = shirt.getByRole("link", { name: "Color: Black", exact: true });
    const white = shirt.getByRole("link", { name: "Color: White", exact: true });
    await black.scrollIntoViewIfNeeded();
    const bounds = await black.boundingBox();
    if (!bounds) throw new Error("Black colour control is missing");
    const pointer = {
      pointerType: "touch", pointerId: 7, isPrimary: true,
      clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2,
    };
    await black.dispatchEvent("pointerdown", pointer);
    await expect(white).toHaveAttribute("aria-current", "true");
    await black.dispatchEvent("pointercancel", pointer);
    await black.dispatchEvent("pointerup", pointer);
    await expect(white).toHaveAttribute("aria-current", "true");

    await black.dispatchEvent("pointerdown", pointer);
    await black.dispatchEvent("pointerup", { ...pointer, clientX: bounds.x - 20 });
    await expect(white).toHaveAttribute("aria-current", "true");

    await black.dispatchEvent("pointerdown", pointer);
    await black.dispatchEvent("contextmenu");
    await black.dispatchEvent("pointerup", pointer);
    await expect(white).toHaveAttribute("aria-current", "true");

    await black.click();
    await expect(black).toHaveAttribute("aria-current", "true");
    await white.tap();
    await black.focus();
    await expect(white).toHaveAttribute("aria-current", "true");
    await black.press("Enter");
    await expect(black).toHaveAttribute("aria-current", "true");
    await expect(page).toHaveURL(/Color=Black/);
  });
});

for (const width of [390, 1440]) {
  test(`completed video retains its paused picture across swipes at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    const media = await readFile(resolve("e2e/fixtures/story-video.mp4"));
    const requests: string[] = [];
    await page.route("**/api/configured-product-video/**", async route => {
      if (new URL(route.request().url()).pathname.endsWith("/events")) {
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
        return;
      }
      if (route.request().method() === "GET") requests.push(route.request().url());
      await route.fulfill({ status: 200, headers: { etag: '"paused-picture"', "content-type": "video/mp4" }, body: media });
    });
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M");
    const panel = page.getByRole("tabpanel", { name: "t-shirt", exact: true });
    const gallery = panel.getByRole("region", { name: "Product gallery" });
    await expect(panel.getByRole("button", { name: "Show story video", exact: true })).toBeVisible();
    await expect(page.locator("video[src]")).toHaveCount(0);
    await panel.getByRole("button", { name: "Show story video", exact: true }).click();
    const player = panel.locator('video[data-selected="true"]');
    await expect.poll(() => player.evaluate(video => video instanceof HTMLVideoElement ? video.readyState : 0)).toBeGreaterThanOrEqual(2);
    await player.evaluate(video => {
      if (!(video instanceof HTMLVideoElement)) throw new Error("Expected video player.");
      video.addEventListener("emptied", () => { video.dataset["emptied"] = "true"; });
    });
    await expect(panel.getByRole("button", { name: "Replay video", exact: true })).toBeVisible({ timeout: 12_000 });
    const source = await player.getAttribute("src");
    const time = await player.evaluate(video => video instanceof HTMLVideoElement ? video.currentTime : -1);
    const picture = () => player.evaluate(video => {
      if (!(video instanceof HTMLVideoElement)) throw new Error("Expected video player.");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Expected picture canvas.");
      context.drawImage(video, 0, 0);
      return canvas.toDataURL();
    });
    const pausedPicture = await picture();
    const swipe = async (direction: "left" | "right") => {
      const bounds = await gallery.boundingBox();
      if (!bounds) throw new Error("Expected gallery bounds.");
      const start = bounds.x + bounds.width * (direction === "left" ? 0.9 : 0.1);
      const end = bounds.x + bounds.width * (direction === "left" ? 0.1 : 0.9);
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(start, y);
      await page.mouse.down();
      await page.mouse.move(end, y, { steps: 12 });
      await page.mouse.up();
    };
    const settled = () => expect.poll(async () => {
      const slide = await panel.locator('[id^="product-media-"][aria-hidden="false"]').boundingBox();
      const viewportStart = await gallery.evaluate(element => element.getBoundingClientRect().left + element.clientLeft);
      return slide ? Math.abs(slide.x - viewportStart) : Infinity;
    }).toBeLessThan(1);
    for (let visit = 0; visit < 3; visit++) {
      await swipe("right");
      await expect(panel.getByRole("button", { name: "Show story video", exact: true })).toHaveAttribute("aria-pressed", "false");
      await settled();
      await expect(player).toHaveAttribute("src", source ?? "");
      expect(await player.evaluate(video => video instanceof HTMLVideoElement && video.paused)).toBe(true);
      await swipe("left");
      await expect(panel.getByRole("button", { name: "Show story video", exact: true })).toHaveAttribute("aria-pressed", "true");
      await settled();
      expect(await player.evaluate(video => video instanceof HTMLVideoElement ? video.currentTime : -1)).toBe(time);
      expect(await picture()).toBe(pausedPicture);
      await expect(player).not.toHaveAttribute("data-emptied", "true");
    }
    expect(requests).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath(`paused-video-${width}.png`) });
    await panel.getByRole("link", { name: "Color: Black", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Show product image", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("video[src]")).toHaveCount(0);
    expect(requests).toHaveLength(1);
  });

  test(`loaded lifestyle stays cached when colour changes reset to flatlay at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M");
    const shirt = page.getByRole("tabpanel", { name: "t-shirt", exact: true });
    await expect(shirt.getByRole("button", { name: "Show lifestyle image" })).toBeVisible();
    await shirt.getByRole("link", { name: "Color: Black", exact: true }).click();
    const blackLifestyle = shirt.locator('#product-media-lifestyle [data-lifestyle-color="black"] img');
    await expect(blackLifestyle).toHaveAttribute("alt", /Black/);
    await expect.poll(() => blackLifestyle.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
    await shirt.getByRole("button", { name: "Show lifestyle image" }).click();
    await expect(shirt.locator('#product-media-lifestyle')).toHaveAttribute("aria-hidden", "false");
    await shirt.getByRole("link", { name: "Color: White", exact: true }).click();
    await expect(shirt.locator('#product-media-lifestyle')).toHaveAttribute("aria-hidden", "true");
    await expect(shirt.getByRole("button", { name: "Show product image" })).toHaveAttribute("aria-pressed", "true");
    await shirt.getByRole("button", { name: "Show lifestyle image" }).click();
    await expect(shirt.locator('#product-media-lifestyle [data-lifestyle-color="white"] img')).toBeVisible();
    await expect(shirt.locator('#product-media-lifestyle')).toHaveAttribute("aria-hidden", "false");
  });

  test(`rapid loaded colour switches retain images without image or hidden video requests at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/configured-product-video/**", route => route.fulfill({
      status: 200, headers: { etag: '"synthetic-video"', "content-type": "video/mp4" }, body: "",
    }));
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M");
    const shirt = page.getByRole("tabpanel", { name: "t-shirt", exact: true });
    for (const color of ["White", "Black", "White"]) {
      await shirt.getByRole("link", { name: `Color: ${color}`, exact: true }).click();
      await expect.poll(() => shirt.locator('[data-product-gallery-image] img, #product-media-lifestyle img').evaluateAll(images => images.length >= 2 && images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
    }
    const images = await shirt.locator('[data-product-gallery-image] img, #product-media-lifestyle img').elementHandles();
    await shirt.locator('[data-product-gallery-image] img').evaluateAll(images => {
      const changes: string[] = [];
      Reflect.set(window, "fixtureImageAttributeChanges", changes);
      const observer = new MutationObserver(records => {
        for (const record of records) if (record.attributeName) changes.push(record.attributeName);
      });
      for (const image of images) observer.observe(image, { attributes: true });
    });
    const requests: string[] = [];
    page.on("request", request => {
      if (/\/api\/(configured-product-(image|lifestyle|video)|product-preview)\//.test(request.url())) requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await page.evaluate(async () => {
      const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
      if (!panel) throw new Error("Expected active shirt panel");
      const sample = document.createElement("canvas");
      sample.width = sample.height = 100;
      const context = sample.getContext("2d");
      if (!context) throw new Error("Expected image pixel sampling");
      for (let i = 0; i < 12; i++) {
        const color = i % 2 === 0 ? "Black" : "White";
        const link = panel.querySelector<HTMLAnchorElement>(`a[aria-label="Color: ${color}"]`);
        if (!link) throw new Error(`Expected ${color} selector`);
        link.click();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const image = panel.querySelector('[data-variant-active="true"] img');
        if (!(image instanceof HTMLImageElement) || !image.complete || !image.naturalWidth) {
          throw new Error("Expected a decoded flatlay on the next frame");
        }
        context.drawImage(image, 0, 0, 100, 100);
        const pixel = context.getImageData(50, 45, 1, 1).data;
        const brightness = ((pixel[0] ?? 0) + (pixel[1] ?? 0) + (pixel[2] ?? 0)) / 3;
        if (color === "Black" ? brightness > 100 : brightness < 180) {
          throw new Error(`Expected ${color} flatlay pixels on the next frame`);
        }
      }
    });
    await expect(page).toHaveURL(/Color=White/);
    for (const image of images) expect.soft(await image.evaluate(element => element.isConnected)).toBe(true);
    await page.waitForTimeout(100);
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, "fixtureImageAttributeChanges"))).toEqual([]);
    await expect(shirt.locator("video[src]")).toHaveCount(0);
  });

  test(`pending lifestyle previews remain drawn across rapid colour switches at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function (...args) {
        Reflect.set(window, "fixtureLifestyleDraws", Number(Reflect.get(window, "fixtureLifestyleDraws") ?? 0) + 1);
        return draw.apply(this, args);
      };
    });
    await page.goto("/product/6c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M");
    const shirt = page.getByRole("tabpanel", { name: "t-shirt", exact: true });
    const lifestyle = shirt.locator('#product-media-lifestyle');
    // Software GPU startup and image encoding are slower on hosted runners.
    // This is warm-up only; switching below must reuse the same URLs and draws.
    await expect.poll(() => lifestyle.locator('img[src^="blob:"]').evaluateAll(images => images.length === 2 && images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)), { timeout: 15_000 }).toBe(true);
    await shirt.getByRole("button", { name: "Show lifestyle image" }).click();
    await expect(lifestyle).toHaveAttribute("aria-hidden", "false");
    const viewport = shirt.locator('[data-slot="carousel-content"]');
    const waitForLifestyle = async () => { await expect.poll(async () => {
      const slideBox = await lifestyle.boundingBox(), viewportBox = await viewport.boundingBox();
      return slideBox && viewportBox ? Math.abs(slideBox.x - viewportBox.x) : Infinity;
    }).toBeLessThan(2); };
    await waitForLifestyle();
    const sources = await lifestyle.locator("img").evaluateAll(images => images.map(image => image.getAttribute("src")));
    const draws = await page.evaluate(() => Reflect.get(window, "fixtureLifestyleDraws"));
    expect(draws).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("pending-lifestyle-white.png"), style: "nextjs-portal { visibility: hidden; }" });
    await shirt.getByRole("link", { name: "Color: Black", exact: true }).click();
    await expect(shirt.getByRole("button", { name: "Show product image" })).toHaveAttribute("aria-pressed", "true");
    await shirt.getByRole("button", { name: "Show lifestyle image" }).click();
    await waitForLifestyle();
    await expect(lifestyle.locator('[data-lifestyle-color="black"] img')).toBeVisible();
    const blackBox = await lifestyle.boundingBox(), viewportBox = await viewport.boundingBox();
    expect(blackBox && viewportBox ? Math.abs(blackBox.x - viewportBox.x) : Infinity).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath("pending-lifestyle-black.png"), style: "nextjs-portal { visibility: hidden; }" });
    for (const color of ["White", "Black", "White", "Black", "White"]) {
      await shirt.getByRole("link", { name: `Color: ${color}`, exact: true }).click();
      await expect(shirt.getByRole("button", { name: "Show product image" })).toHaveAttribute("aria-pressed", "true");
      await shirt.getByRole("button", { name: "Show lifestyle image" }).click();
      await expect(lifestyle.locator(`[data-lifestyle-color="${color.toLowerCase()}"] img`)).toBeVisible();
    }
    expect(await lifestyle.locator("img").evaluateAll(images => images.map(image => image.getAttribute("src")))).toEqual(sources);
    expect(await page.evaluate(() => Reflect.get(window, "fixtureLifestyleDraws"))).toBe(draws);
  });
}

for (const width of [390, 1440]) {
  test(`new product permits adding while print files are pending at ${String(width)}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/product-purchase-readiness/*", route => route.fulfill({ json: { ready: false } }));
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M");
    await expect(page.getByRole("button", { name: /Add to cart$/ })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "Size", exact: true })).toContainText("M");
    await selectShirtSize(page, "L");
    await expect(page.getByRole("button", { name: /Add to cart$/ })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "Size", exact: true })).toContainText("L");
    await expect(page.getByText(/currently unavailable/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("product-add-before-print-ready.png"), fullPage: true });
  });
}

test("selected size is visible before client scripts load", async ({ page }) => {
  const scripts = Promise.withResolvers<void>();
  await page.route("**/_next/static/**/*.js", async route => {
    await scripts.promise;
    await route.continue();
  });
  try {
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M", { waitUntil: "commit" });
    await expect(page.getByRole("combobox", { name: "Size" })).toContainText("M");
  } finally {
    scripts.resolve();
  }
});

test("checkout reaches the application sales gate before Shopify routing", async ({ request }) => {
  const response = await request.get("/checkout", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  const location = new URL(response.headers()["location"] ?? "", response.url());
  expect(location.pathname).toBe("/cart");
  expect(location.searchParams.get("cartError")).toBe("Orders are temporarily paused. Please check back soon.");
  expect(location.searchParams.has("payment")).toBe(false);
});

test("local product controls hydrate and retain size choice across product switches", async ({ page }) => {
  await page.goto("/?shirtColor=White");
  await expect(page.getByRole("combobox", { name: "Size" })).toContainText("Choose size");
  await selectShirtSize(page, "M");
  await expect(page.getByRole("combobox", { name: "Size" })).toContainText("M");
  await page.getByRole("tab", { name: "tote", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Size" })).toHaveCount(0);
  await page.getByRole("tab", { name: "t-shirt", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Size" })).toContainText("M");
  await expect(page).toHaveURL(/shirtSize=M/);
});

test("product link copying retains the current query parameters", async ({ page }) => {
  await page.route("**/api/product-purchase-readiness/*", route => route.fulfill({ json: { ready: false } }));
  await page.addInitScript(() => {
    const clipboard = {
      writeText: (value: string) => {
        Reflect.set(window, "__copiedProductUrl", value);
        return Promise.resolve();
      },
    };
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      get: () => clipboard,
    });
  });
  await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M&utm_content=share-test");
  const copyLink = page.locator('[data-product-action="share"]:visible');

  await expect(copyLink).toHaveAccessibleName("Copy product link");

  await copyLink.click();

  await expect(copyLink).toHaveAccessibleName("Product link copied");
  await expect(copyLink.locator('[data-copy-icon="check"]')).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Copied$/ })).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__copiedProductUrl")))
    .toBe(page.url());
});

for (const width of [390, 1440]) {
  test(`configured product streams estimates and prioritizes its image at ${String(width)}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const invalidation = await request.post("/api/internal/revalidate-products", {
      headers: { "x-forever-tee-service-secret": "ci-shared-secret-at-least-random" },
      // Clearing this fixture cache is idempotent. Retry one ECONNRESET from
      // a closed dev-server connection; HTTP failures still fail the setup.
      maxRetries: 1,
    });
    expect(invalidation.ok()).toBe(true);
    const releaseImage = Promise.withResolvers<void>();
    const releaseLifestyle = Promise.withResolvers<void>();
    await page.route("**/api/configured-product-image/**", async route => {
      await releaseImage.promise;
      await route.continue();
    });
    await page.route("**/api/configured-product-lifestyle/**", async route => {
      await releaseLifestyle.promise;
      await route.continue();
    });
    await page.route("**/api/configured-product-video/**", route => route.fulfill({
      status: 200, headers: { etag: '"synthetic-video"', "content-type": "video/mp4" }, body: "",
    }));
    const start = performance.now();
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M", { waitUntil: "commit" });
    const slot = page.locator("[data-fulfilment-slot]:visible");
    const size = page.getByRole("combobox", { name: "Size" });
    await expect(size).toContainText("M");
    const controlsReadyMs = Math.round(performance.now() - start);
    const before = await slot.boundingBox();
    const actionsBefore = await page.locator('[data-product-action="share"]:visible').boundingBox();
    if (process.env["E2E_LOCAL_PRODUCTION"] === "1") {
      await expect(slot.locator("[data-fulfilment-estimate]")).toHaveCount(0);
      // Exercise a real choice while the streamed estimate is still pending.
      await selectShirtSize(page, "L");
      await expect(size).toContainText("L");
    }

    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("button", { name: "Show story video", exact: true })).toBeVisible();
    const earlyVideos = await page.locator("video[src]").count();
    const highPriorityImages = await page.locator('img[fetchpriority="high"]').count();
    // The first image route also compiles on the cold development CI server.
    const visibleImageResponse = page.waitForResponse(response =>
      response.url().includes("/api/configured-product-image/"), { timeout: 15_000 });
    releaseImage.resolve();
    expect(earlyVideos).toBe(0);
    expect(highPriorityImages).toBe(1);
    expect((await visibleImageResponse).ok()).toBe(true);
    await expect.poll(() => panel.locator('[data-variant-active="true"] img[src*="configured-product-image"]').evaluate(image =>
      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
    const imageSource = await panel.locator('[data-variant-active="true"] img[src*="configured-product-image"]').evaluate(image =>
      image instanceof HTMLImageElement ? image.currentSrc : "");
    expect(imageSource).toContain("width=");
    await expect(page.locator("video[src]")).toHaveCount(0);
    await panel.getByRole("button", { name: "Show story video", exact: true }).click();
    await expect(page.locator("video[src]")).toHaveCount(1);
    // A late lifestyle preview inserts a slide ahead of the playing video.
    // Preserve playback and selection through the real carousel's reInit.
    releaseLifestyle.resolve();
    await expect(panel.getByRole("button", { name: "Show lifestyle image", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Show story video", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator("#product-media-video")).toBeInViewport({ratio:0.95});
    await expect(page.locator("video[src]")).toHaveCount(1);
    await panel.getByRole("button", { name: "Show product image", exact: true }).click();
    await expect(page.locator("video[src]")).toHaveCount(1);
    await expect(slot).toContainText("shipping: 3 to 5 business days");
    if (process.env["E2E_LOCAL_PRODUCTION"] === "1") await expect(size).toContainText("L");
    expect(await slot.boundingBox()).toEqual(before);
    expect(await page.locator('[data-product-action="share"]:visible').boundingBox()).toEqual(actionsBefore);
    console.info("Fulfilment streaming fixture", JSON.stringify({ width, controlsReadyMs, estimateReadyMs: Math.round(performance.now() - start), slotHeight: before?.height }));
    await page.screenshot({ path: testInfo.outputPath(`configured-shirt-${String(width)}.png`) });
    await panel.getByRole("button", { name: "Show lifestyle image", exact: true }).click();
    const lifestyle = panel.locator("#product-media-lifestyle");
    await expect(lifestyle).toHaveAttribute("aria-hidden", "false");
    await expect(lifestyle).toBeInViewport({ratio:0.95});
    await expect.poll(() => lifestyle.locator('[data-lifestyle-color]:not([hidden]) img').evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`configured-lifestyle-${String(width)}.png`)});
    await panel.getByRole("button", {name:"Show product image",exact:true}).click();
    await page.getByRole("tab", { name: "tote", exact: true }).click();
    // A new colour/width image can still be cold on the development server.
    // Match the initial image allowance without slowing successful responses.
    await expect.poll(() => panel.locator('[data-variant-active="true"] img[src*="configured-product-image"]').evaluate(image =>
      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`configured-tote-${String(width)}.png`) });
    console.info("Responsive product fixture", JSON.stringify({ viewport: width, imageSource, earlyVideos, highPriorityImages }));
    // Option-only navigations reuse the same two catalogue entries.
    for (const query of ["Color=White&Size=S", "Color=Black&Size=M", "Color=White&Size=L"]) {
      // Retry only a closed dev-server TCP connection on this idempotent read;
      // HTTP errors and the earlier streaming/preview limits still fail.
      expect((await request.get(`/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?${query}`, { maxRetries: 1 })).ok()).toBe(true);
    }
  });
}

for (const width of [390, 1440]) {
  test(`product image pending and failed states stay stable and recover at ${width}px`, async ({page}, testInfo) => {
    await page.setViewportSize({width,height:900});
    let mode: "pending" | "failed" | "ready" = "pending";
    await page.route("**/api/configured-product-image/**", route => mode === "ready" ? route.continue() : route.fulfill({status:mode === "pending" ? 202 : 410}));
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M",{waitUntil:"domcontentloaded"});
    const panel=page.getByRole("tabpanel",{name:"t-shirt",exact:true});
    const image=panel.locator('[data-variant-active="true"] img[src*="configured-product-image"]');
    const frame=image.locator("..");
    await expect(panel.getByRole("status").filter({hasText:"Preparing preview"})).toBeVisible();
    const bounds=await frame.boundingBox();
    await page.screenshot({path:testInfo.outputPath("product-image-pending.png"),fullPage:true});
    mode="failed";
    await expect(panel.getByRole("status").filter({hasText:"Preview could not be loaded"})).toBeVisible();
    await expect(image).toBeHidden();
    expect(await frame.boundingBox()).toEqual(bounds);
    await expect(page.getByRole("button",{name:/Add to cart$/})).toBeEnabled();
    await page.screenshot({path:testInfo.outputPath("product-image-retry.png"),fullPage:true});
    mode="ready";
    await panel.getByRole("button",{name:"Try again",exact:true}).click();
    await expect(image).toBeVisible();
    await expect.poll(()=>image.evaluate(node=>node instanceof HTMLImageElement && node.naturalWidth>0)).toBe(true);
    expect(await frame.boundingBox()).toEqual(bounds);
    await page.screenshot({path:testInfo.outputPath("product-image-recovered.png"),fullPage:true});
  });
}

for (const width of [390, 1440]) {
  test(`a product image completing after the slow notice appears automatically at ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    await page.clock.install();
    let ready=false;
    await page.route("**/api/configured-product-image/**", route=>ready?route.continue():route.fulfill({status:202,headers:{"retry-after":"2"}}));
    // The loading message is server-rendered. Wait for a completed readiness
    // poll to prove hydration installed the timers before advancing the clock.
    const polling = page.waitForResponse(response =>
      response.request().method() === "HEAD" &&
      response.url().includes("/api/configured-product-image/") &&
      response.status() === 202);
    await page.goto("/product/4c22bf7e-e698-4a0a-90c4-66c5549f1c45?Color=White&Size=M");
    const frame=page.locator("[data-product-gallery-image]:visible");
    const bounds=await frame.boundingBox();
    await expect(frame.getByRole("status")).toContainText("Preparing preview");
    await polling;
    await page.clock.fastForward(16_000);
    await expect(frame.getByRole("status")).toContainText("taking longer");
    ready=true;
    await page.clock.runFor(2_100);
    const image=frame.locator('[data-variant-active="true"] img');
    await expect(image).toBeVisible();
    await expect.poll(()=>image.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
    await expect(frame.getByRole("status")).toHaveCount(0);
    expect(await frame.boundingBox()).toEqual(bounds);
  });
}
