import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
import { standardActionsFixture } from "./standard-actions-fixture.mjs";
import { verifyDuplicatePrintDelivery } from "./print-delivery-proof.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function browserJourney({
  events,
  blocked,
  artifact,
  releaseImages,
  queue,
  deliverPrint,
  db,
  api,
  secret,
  shopify,
  videoTasks,
  videos,
  artwork,
  sourceFormat = "png",
}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const foreign = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const width = sourceFormat === "jpeg" ? 5000 : 4096;
  const height = sourceFormat === "jpeg" ? 10000 : 5120;
  const pipeline = sharp(
    Buffer.from(
      '<svg width="4096" height="5120"><rect width="4096" height="5120" fill="#1647ff"/><rect x="640" y="1500" width="2900" height="3200" fill="#ffcf33"/><circle cx="2100" cy="1150" r="870" fill="#ff538d"/><rect x="150" y="250" width="190" height="370" fill="white"/></svg>',
    ),
  ).resize(width, height);
  const source = await (
    sourceFormat === "jpeg"
      ? pipeline.jpeg({ quality: 92 }).withMetadata({ orientation: 6 })
      : sourceFormat === "webp"
        ? pipeline.webp({ lossless: true })
        : pipeline.png()
  ).toBuffer();
  await writeFile(`${artifact}/synthetic-original.${sourceFormat}`, source, {
    mode: 0o600,
  });
  events.push({
    operation: "synthetic-source",
    width,
    height,
    format: sourceFormat,
    exifOrientation: sourceFormat === "jpeg" ? 6 : 1,
    sha256: createHash("sha256").update(source).digest("hex"),
    bytes: source.length,
  });
  for (const ctx of [context, foreign]) {
    await ctx.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        return route.continue();
      if (
        url.origin === "https://cdn.shopify.com" &&
        url.pathname === "/storefront/standard-actions.js"
      )
        return route.fulfill({
          contentType: "application/javascript",
          body: standardActionsFixture,
        });
      if (
        url.origin === "https://challenges.cloudflare.com" &&
        url.pathname === "/turnstile/v0/api.js"
      )
        return route.fulfill({
          contentType: "application/javascript",
          body: 'window.turnstile={render:function(element,options){setTimeout(()=>options.callback("synthetic-turnstile-token"),0);return "fixture-widget";},remove:function(){},reset:function(){}};window.bentTurnstileReady?.();',
        });
      blocked.push({
        boundary: "browser",
        origin: url.origin,
        path: url.pathname,
      });
      return route.abort("blockedbyclient");
    });
    await ctx.addInitScript(() => {
      window.__cameraCalls = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.__cameraCalls++;
        throw new Error("Physical camera is disabled in this proof.");
      };
    });
  }
  try {
    const page = await context.newPage();
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        const url = new URL(frame.url());
        events.push({
          operation: "navigation",
          path: url.pathname,
          upload: url.searchParams.get("upload"),
          camera: url.searchParams.get("camera"),
        });
      }
    });
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/api/cart" &&
        request.method() === "POST"
      )
        events.push({
          operation: "cart-write-request",
          body: request.postData(),
        });
      if (new URL(request.url()).pathname === "/api/design-drafts")
        events.push({
          operation: "draft-request",
          challengeLength: request.headers()["x-turnstile-token"]?.length ?? 0,
        });
    });
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname === "/api/cart") {
        const payload = await response.json().catch(() => null);
        if (payload?.userErrors?.length)
          events.push({ operation: "cart-error", errors: payload.userErrors });
      }
      if (
        new URL(response.url()).pathname.startsWith("/api/") ||
        response.status() >= 400
      )
        events.push({
          operation: "browser-api",
          path: new URL(response.url()).pathname,
          status: response.status(),
          ...(new URL(response.url()).pathname === "/cart"
            ? {
                cartError: new URL(response.url()).searchParams.get(
                  "cartError",
                ),
              }
            : {}),
          ...(response.status() >= 400
            ? { body: (await response.text().catch(() => "")).slice(0, 500) }
            : {}),
        });
    });
    page.on("pageerror", (error) =>
      events.push({ operation: "browser-error", message: error.message }),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        events.push({
          operation: "browser-console-error",
          message: message.text().slice(0, 250),
        });
    });
    await page.goto("http://localhost:4517/create");
    await expect(
      page.getByRole("button", { name: "Upload image", exact: true }),
    ).toBeVisible();
    const refused = await context.request.post(
      "http://localhost:4517/api/design-drafts",
      {
        headers: {
          origin: "http://localhost:4517",
          "x-turnstile-token": "synthetic-turnstile-token",
        },
      },
    );
    assert.equal(refused.status(), 403);
    events.push({ operation: "consent-required", status: 403 });
    await page.getByRole("checkbox").check();
    await page.getByLabel("Choose image", { exact: true }).setInputFiles({
      name: `synthetic-asymmetric-portrait.${sourceFormat}`,
      mimeType: `image/${sourceFormat}`,
      buffer: source,
    });
    await expect(
      page.getByRole("img", { name: "Your uploaded photo" }),
    ).toBeVisible({ timeout: 60000 });
    events.push({
      operation: "upload-review",
      urlPath: new URL(page.url()).pathname,
    });
    const designId = new URL(page.url()).pathname.split("/").at(-1);
    const privateRead = await foreign.request.get(
      `http://localhost:4517/api/design-drafts/${designId}`,
    );
    assert.equal(privateRead.status(), 404);
    const foreignSource = await foreign.request.get(
      `http://localhost:4517/api/design-drafts/${designId}/artwork-sources/original`,
    );
    assert.equal(foreignSource.status(), 404);
    events.push({
      operation: "foreign-owner-draft-and-source-denied",
      status: 404,
    });
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(
      page.locator("canvas.editor-direct-manipulation-cue"),
    ).toBeVisible({ timeout: 60000 });
    const background = page.getByRole("checkbox", {
      name: "Background",
      exact: true,
    });
    const effect = page.getByRole("checkbox", { name: "Effect", exact: true });
    const beforeCrop = await (
      await context.request.get(
        `http://localhost:4517/api/design-drafts/${designId}`,
      )
    ).json();
    const canvasBounds = await page
      .locator("canvas.editor-direct-manipulation-cue")
      .boundingBox();
    assert.ok(canvasBounds);
    await page.mouse.move(
      canvasBounds.x + canvasBounds.width * 0.12,
      canvasBounds.y + canvasBounds.height * 0.35,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvasBounds.x + canvasBounds.width * 0.22,
      canvasBounds.y + canvasBounds.height * 0.44,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect
      .poll(async () =>
        JSON.stringify(
          (
            await (
              await context.request.get(
                `http://localhost:4517/api/design-drafts/${designId}`,
              )
            ).json()
          ).settings,
        ),
      )
      .not.toBe(JSON.stringify(beforeCrop.settings));
    const edited = await (
      await context.request.get(
        `http://localhost:4517/api/design-drafts/${designId}`,
      )
    ).json();
    events.push({
      operation: "direct-editor-gesture",
      before: beforeCrop.settings,
      after: edited.settings,
    });
    await background.check();
    await expect(background).toBeChecked();
    await effect.uncheck();
    await expect(effect).not.toBeChecked();
    await page.waitForTimeout(500);
    await page.reload();
    await expect(background).toBeChecked({ timeout: 30000 });
    await expect(effect).not.toBeChecked();
    const reloaded = await (
      await context.request.get(
        `http://localhost:4517/api/design-drafts/${designId}`,
      )
    ).json();
    for (const key of [
      "cropX",
      "cropY",
      "cropZoom",
      "placementX",
      "placementY",
      "placementWidth",
    ])
      assert.equal(reloaded.settings[key], edited.settings[key]);
    await background.uncheck();
    await effect.check();
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    events.push({ operation: "editor-reload", designId });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/\/product\//, { timeout: 60000 });
    events.push({
      operation: "configured-family",
      urlPath: new URL(page.url()).pathname,
    });
    const productId = new URL(page.url()).pathname.split("/").at(-1);
    const eventStream = await fetch(
      `http://localhost:4517/api/configured-product-video/${productId}/events`,
      { signal: AbortSignal.timeout(30000) },
    );
    assert.equal(eventStream.status, 200);
    assert.equal(
      eventStream.headers.get("cache-control"),
      "private, no-store, no-transform",
    );
    const reader = eventStream.body.getReader();
    const firstEvent = await reader.read();
    assert.equal(firstEvent.done, false);
    const eventCompletion = (async () => {
      let text = new TextDecoder().decode(firstEvent.value);
      for (
        let next = await reader.read();
        !next.done;
        next = await reader.read()
      )
        text += new TextDecoder().decode(next.value);
      return text;
    })();
    void eventCompletion.catch(() => {});
    events.push({
      operation: "sse-first-bytes",
      readyCount: (
        await db
          .prepare(
            "SELECT count(*) AS count FROM story_video_jobs WHERE status='ready'",
          )
          .first()
      ).count,
    });
    await expect(
      page.getByRole("tab", { name: "t-shirt", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page.getByRole("combobox", { name: "Size", exact: true }).click();
    await page.getByRole("option", { name: "M", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Add to cart/ }),
    ).toBeEnabled();
    await page.getByRole("button", { name: /Add to cart/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByText("Your cart is empty.", { exact: true }),
    ).not.toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await (
              await context.request.get("http://localhost:4517/api/cart")
            ).json()
          ).cart?.lines.nodes.length ?? 0,
      )
      .toBe(1);
    const pendingCheckout = await context.request.get(
      "http://localhost:4517/checkout",
      { maxRedirects: 0 },
    );
    assert.equal(pendingCheckout.status(), 303);
    assert.match(
      new URL(pendingCheckout.headers()["location"]).searchParams.get(
        "cartError",
      ) ?? "",
      /artwork is still being prepared/,
    );
    events.push({ operation: "unready-print-checkout-denied", status: 303 });
    await page.getByRole("button", { name: "Close cart", exact: true }).click();
    await page.getByRole("tab", { name: "tote", exact: true }).click();
    await page.getByRole("link", { name: "Color: Cream", exact: true }).click();
    await page.getByRole("button", { name: /Add to cart/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await (
              await context.request.get("http://localhost:4517/api/cart")
            ).json()
          ).cart?.lines.nodes.length ?? 0,
      )
      .toBe(2);
    releaseImages();
    await deliverPrint();
    await expect
      .poll(
        async () =>
          (
            await db
              .prepare(
                "SELECT count(*) AS count FROM product_image_jobs WHERE status='ready'",
              )
              .first()
          ).count,
        { timeout: 60000 },
      )
      .toBe(6);
    await expect
      .poll(
        async () =>
          (
            await db
              .prepare(
                "SELECT count(*) AS count FROM print_asset_jobs WHERE status='ready'",
              )
              .first()
          ).count,
        { timeout: 60000 },
      )
      .toBe(2);
    const fullSources = await db
      .prepare(
        "SELECT kind,artwork_key,sha256,byte_size,width,height FROM design_artwork_sources WHERE design_id=?",
      )
      .bind(designId)
      .all();
    for (const row of fullSources.results) {
      const object = await artwork.get(row.artwork_key);
      assert.ok(object);
      const bytes = Buffer.from(await object.arrayBuffer());
      const metadata = await sharp(bytes).metadata();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, row.sha256);
      assert.equal(metadata.width, row.width);
      assert.equal(metadata.height, row.height);
      await writeFile(`${artifact}/prepared-${row.kind}.bin`, bytes, {
        mode: 0o600,
      });
      events.push({
        operation: "prepared-source-verified",
        kind: row.kind,
        sha256,
        bytes: bytes.length,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      });
    }
    const images = await db
      .prepare(
        "SELECT id,view,storage_key,sha256,byte_size FROM product_image_jobs WHERE status='ready'",
      )
      .all();
    for (const image of images.results) {
      const object = await artwork.get(image.storage_key);
      assert.ok(object);
      const bytes = Buffer.from(await object.arrayBuffer());
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        image.sha256,
      );
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 768);
      assert.equal(metadata.height, image.view === "flat" ? 768 : 1024);
      events.push({
        operation: "stored-image-verified",
        jobId: image.id,
        width: metadata.width,
        height: metadata.height,
        sha256: image.sha256,
      });
    }
    const readyImage = await context.request.get(
      `http://localhost:4517/api/configured-product-image/current/${productId}/black.webp?width=384`,
    );
    assert.equal(readyImage.status(), 200);
    assert.equal(readyImage.headers()["cache-control"], "private, no-store");
    assert.equal((await sharp(await readyImage.body()).metadata()).width, 768);
    events.push({
      operation: "bff-image-ready",
      status: 200,
      requestedWidth: 384,
      canonicalWidth: 768,
    });
    const prints = await db
      .prepare(
        "SELECT coalesce(objects.storage_key,assets.storage_key) AS storage_key,assets.width_px AS width,assets.height_px AS height,assets.sha256 FROM print_assets AS assets LEFT JOIN print_asset_objects AS objects ON objects.sha256=assets.object_sha256 WHERE assets.status='ready'",
      )
      .all();
    for (const print of prints.results) {
      const object = await artwork.get(print.storage_key);
      assert.ok(object);
      const bytes = Buffer.from(await object.arrayBuffer());
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.format, "png");
      assert.equal(metadata.width, print.width);
      assert.equal(metadata.height, print.height);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        print.sha256,
      );
      events.push({
        operation: "stored-print-verified",
        width: metadata.width,
        height: metadata.height,
        sha256: print.sha256,
      });
    }
    events.push({
      operation: "quantity-before",
      inputs: await page
        .locator('input[name="lineId"]')
        .evaluateAll((inputs) => inputs.map((input) => input.value)),
      server: (
        await (
          await context.request.get("http://localhost:4517/api/cart")
        ).json()
      ).cart.lines.nodes.map((line) => ({
        id: line.id,
        quantity: line.quantity,
      })),
    });
    await expect
      .poll(
        async () =>
          (
            await db
              .prepare(
                "SELECT count(*) AS count FROM story_video_jobs WHERE status='ready'",
              )
              .first()
          ).count,
        { timeout: 60000 },
      )
      .toBe(4);
    const streamed = await eventCompletion;
    assert.match(streamed, /event: complete/);
    assert.match(streamed, /"status":"ready"/);
    const reconnected = await fetch(
      `http://localhost:4517/api/configured-product-video/${productId}/events`,
      { signal: AbortSignal.timeout(5000) },
    );
    const snapshot = await reconnected.text();
    assert.equal((snapshot.match(/"status":"ready"/g) ?? []).length, 4);
    assert.match(snapshot, /event: complete/);
    events.push({ operation: "sse-complete-and-reconnect", ready: 4 });
    const videoRows = await db
      .prepare(
        "SELECT id,product_id,colour,story_key FROM story_video_jobs WHERE status='ready'",
      )
      .all();
    for (const video of videoRows.results) {
      const object = await videos.get(video.story_key);
      assert.ok(object);
      const file = `${artifact}/${video.id}.mp4`;
      await writeFile(file, Buffer.from(await object.arrayBuffer()), {
        mode: 0o600,
      });
      const probe = JSON.parse(
        (
          await execute("ffprobe", [
            "-v",
            "quiet",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            file,
          ])
        ).stdout,
      );
      const stream = probe.streams.find(
        (stream) => stream.codec_type === "video",
      );
      assert.equal(stream.width, 1080);
      assert.equal(stream.height, 1920);
      assert.equal(stream.r_frame_rate, "30/1");
      assert.ok(Math.abs(Number(probe.format.duration) - 8) < 0.1);
      const response = await context.request.get(
        `http://localhost:4517/api/configured-product-video/${video.product_id}/${video.colour.toLowerCase()}.mp4`,
      );
      assert.equal(response.status(), 200);
      assert.equal(response.headers()["cache-control"], "private, no-store");
      events.push({
        operation: "stored-video-verified",
        jobId: video.id,
        width: 1080,
        height: 1920,
        frameRate: "30/1",
        duration: Number(probe.format.duration),
      });
    }
    await page
      .getByRole("button", { name: /Increase quantity of/ })
      .first()
      .click();
    await expect
      .poll(
        async () =>
          (
            await (
              await context.request.get("http://localhost:4517/api/cart")
            ).json()
          ).cart?.totalQuantity ?? 0,
      )
      .toBe(3);
    const checkout = await context.request.get(
      "http://localhost:4517/checkout",
      { maxRedirects: 0 },
    );
    assert.equal(checkout.status(), 307);
    assert.equal(
      checkout.headers()["location"],
      "https://checkout.example.invalid/cart/c/J01",
    );
    events.push({
      operation: "inert-checkout-handoff",
      status: 307,
      location: checkout.headers()["location"],
    });
    const pause = await api.fetch(
      new Request(
        new URL("/v2/internal/operations/sales-pause", await api.url),
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-bent-shirt-operations-secret": "synthetic-operations-secret",
          },
          body: JSON.stringify({
            paused: true,
            reason: "Synthetic pause assertion",
          }),
        },
      ),
    );
    assert.equal(pause.status, 200);
    const paused = await context.request.get("http://localhost:4517/checkout", {
      maxRedirects: 0,
    });
    assert.equal(paused.status(), 303);
    assert.match(
      new URL(paused.headers()["location"]).searchParams.get("cartError") ?? "",
      /Orders are temporarily paused/,
    );
    events.push({ operation: "manual-pause-checkout-denied", status: 303 });
    const before = await db
      .prepare(
        "SELECT count(*) AS count FROM product_image_jobs WHERE status='ready'",
      )
      .first();
    const wrong = await api.fetch(
      new Request(
        new URL(
          `/v2/internal/product-image-jobs/${images.results[0].id}/image`,
          await api.url,
        ),
        {
          method: "PUT",
          headers: {
            authorization: "Bearer wrong.callback",
            "x-image-renderer-version": "product-images-v5",
            "x-image-execution-id": crypto.randomUUID(),
          },
          body: new Uint8Array([1, 2, 3]),
        },
      ),
    );
    assert.equal(wrong.status, 403);
    assert.equal(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM product_image_jobs WHERE status='ready'",
          )
          .first()
      ).count,
      before.count,
    );
    await verifyDuplicatePrintDelivery(db, deliverPrint);
    const scheduled = await api.scheduled({
      scheduledTime: Date.UTC(2026, 10, 13, 0, 1),
      cron: "* * * * *",
    });
    events.push({ operation: "actual-business-scheduled", result: scheduled });
    assert.equal(scheduled.outcome, "ok");
    assert.equal(
      (await db.prepare("SELECT count(*) AS count FROM paid_orders").first())
        .count,
      0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) AS count FROM printify_fulfilment_orders")
          .first()
      ).count,
      0,
    );
    assert.equal(blocked.filter((item) => !item.boundary).length, 0);

    assert.equal(
      (
        await db
          .prepare("SELECT count(*) AS count FROM products WHERE design_id=?")
          .bind(designId)
          .first()
      ).count,
      2,
    );
    events.push({
      operation: "wrong-image-callback-denied",
      status: 403,
      noEffects: true,
    });
    events.push({
      operation: "product-controls",
      cameraCalls: await page.evaluate(() => window.__cameraCalls),
    });
    assert.equal(await page.evaluate(() => window.__cameraCalls), 0);
    return {
      designId,
      productId: new URL(page.url()).pathname.split("/").at(-1),
    };
  } finally {
    await context.close();
    await foreign.close();
    await browser.close();
  }
}
