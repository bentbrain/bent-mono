import { resolve } from "node:path";
import { expect, test } from "./test";
import { installCameraDevicesFixture, installCameraPreviewFixture } from "./local/camera-preview-fixture";

test.use({
  baseURL: "http://localhost:4317",
  permissions: ["camera"],
  launchOptions: { args: [
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${resolve("e2e/fixtures/portrait-camera.y4m")}`,
  ] },
});

for (const readyBeforeConfirm of [true, false]) {
  test(`photo preview processes in the background, confirm ${readyBeforeConfirm ? "skips" : "shows"} loading`, async ({ page }, testInfo) => {
    const upload = Promise.withResolvers<"success" | "failure">();
    const fixture = await installCameraPreviewFixture(page, () => upload.promise);
    await page.goto("/create");
    // Wait for the responsive server fallback to be replaced before checking
    // its form. These cases exercise uploads after mobile initialization.
    await expect(page.getByRole("img", { name: "QR code to continue creating this design on a phone", includeHidden: true })).toHaveCount(0);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Open camera", exact: true }).click();
    // Navigation includes declaration persistence and cold development compilation.
    await page.waitForURL(/\/design\/[0-9a-f-]+\?camera=1$/);
    const timer = page.getByRole("button", { name: /Photo timer:/ });
    await expect(timer).toContainText("3s");
    await page.screenshot({ style: "nextjs-portal { visibility: hidden; }", path: testInfo.outputPath("camera-timer-mobile.png") });
    for (const seconds of [5, 10, 3]) {
      await timer.click();
      await expect(timer).toContainText(`${seconds}s`);
      await expect(page.getByRole("button", { name: `Take photo in ${seconds} seconds` })).toBeEnabled();
    }
    await page.getByRole("button", { name: "Take photo in 3 seconds" }).click();
    await expect(timer).toBeDisabled();
    const photo = page.getByRole("region", { name: "Photo preview" });
    // Allow the three-second countdown plus capture/encoding on the shared CI
    // runner. This checks preview/upload ordering, not device capture latency.
    await expect(photo).toBeVisible({ timeout: 8_000 });
    await expect.poll(fixture.uploads).toBe(1);
    const loader = page.getByRole("status", { name: "Removing the background from your photo" });
    await expect(loader).toHaveCount(0);
    await page.screenshot({ style: "nextjs-portal { visibility: hidden; }", path: testInfo.outputPath("photo-preview-mobile.png") });
    if (readyBeforeConfirm) {
      upload.resolve("success");
      await expect.poll(() => fixture.traces.some(trace => trace.includes("artwork_preview_loaded"))).toBe(true);
      await expect(photo).toBeVisible();
      await expect(page.locator("canvas.fixed")).toHaveCount(0);
      await expect(loader).toHaveCount(0);
    }
    // Observe even a single loader frame when the cutout was ready at Confirm.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('[aria-label="Removing the background from your photo"]')) {
          document.documentElement.dataset["sawPhotoLoader"] = "true";
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    if (!readyBeforeConfirm) {
      await expect(loader).toBeVisible();
      upload.resolve("success");
    }
    await expect(page.locator("canvas.fixed")).toBeVisible();
    await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
    if (readyBeforeConfirm) await expect(page.locator("html")).not.toHaveAttribute("data-saw-photo-loader", "true");
    await page.screenshot({ style: "nextjs-portal { visibility: hidden; }", path: testInfo.outputPath("confirmed-editor-mobile.png") });
  });
}

test("an interrupted upload stops loading and retries the retained photo only on request", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await installCameraPreviewFixture(page, () => Promise.resolve("success"));
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let attempts = 0;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/fixture-upload")) {
        attempts += 1;
        document.documentElement.dataset["uploadAttempts"] = String(attempts);
        if (attempts === 1) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      }
      return originalFetch(input, init);
    };
  });
  await page.goto("/create");
  await expect(page.getByRole("img", { name: "QR code to continue creating this design on a phone", includeHidden: true })).toHaveCount(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Open camera", exact: true }).click();
  // Navigation includes declaration persistence and cold development compilation.
  await page.waitForURL(/\/design\/[0-9a-f-]+\?camera=1$/);
  await page.getByRole("button", { name: "Take photo in 3 seconds" }).click();
  await expect(page.getByRole("region", { name: "Photo preview" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your photo is still on this device" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Removing the background from your photo" })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-upload-attempts", "1");
  expect(fixture.uploads()).toBe(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-upload-attempts", "2");
  expect(fixture.uploads()).toBe(1);
});

for (const discardedResult of ["success", "failure"]) {
  test(`retake ignores a discarded upload's late ${discardedResult}`, async ({ page }) => {
    // The real countdown/creative animation cases above keep wall-clock time.
    // Here only the old/new upload race matters; tick every countdown timer.
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const discarded = Promise.withResolvers<"success" | "failure">();
    const fixture = await installCameraPreviewFixture(page, upload => upload === 1 ? discarded.promise : Promise.resolve("success"));
    await page.goto("/create");
    await expect(page.getByRole("img", { name: "QR code to continue creating this design on a phone", includeHidden: true })).toHaveCount(0);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Open camera", exact: true }).click();
    // Navigation includes declaration persistence and cold development compilation.
    await page.waitForURL(/\/design\/[0-9a-f-]+\?camera=1$/);
    await page.getByRole("button", { name: /Photo timer:/ }).click();
    await page.getByRole("button", { name: "Take photo in 5 seconds" }).click();
    await page.clock.runFor(5_000);
    await expect(page.getByRole("region", { name: "Photo preview" })).toBeVisible({ timeout: 8_000 });
    await expect.poll(fixture.uploads).toBe(1);
    await page.getByRole("button", { name: "Retake", exact: true }).click();
    await expect(page.getByRole("button", { name: "Take photo in 5 seconds" })).toBeVisible();
    await page.getByRole("button", { name: /Photo timer:/ }).click();
    await expect(page.getByRole("button", { name: "Take photo in 10 seconds" })).toBeEnabled();
    await page.getByRole("button", { name: /Photo timer:/ }).click();
    await page.getByRole("button", { name: "Take photo in 3 seconds" }).click();
    await page.clock.runFor(3_000);
    await expect(page.getByRole("region", { name: "Photo preview" })).toBeVisible();
    const firstResponse = page.waitForResponse("**/fixture-upload");
    discarded.resolve(discardedResult === "success" ? "success" : "failure");
    await firstResponse;
    await expect.poll(fixture.uploads).toBe(2);
    await expect.poll(() => fixture.traces.some(trace => trace.includes("artwork_preview_loaded"))).toBe(true);
    await expect(page.getByRole("region", { name: "Photo preview" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.locator("canvas.editor-direct-manipulation-cue")).toBeVisible();
  });
}


async function openCapture(page: import("@playwright/test").Page) {
  await page.goto("/create");
  await expect(page.getByRole("img", { name: "QR code to continue creating this design on a phone", includeHidden: true })).toHaveCount(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Open camera", exact: true }).click();
  await page.waitForURL(/\/design\/[0-9a-f-]+\?camera=1$/);
  await expect(page.getByRole("button", { name: "Take photo in 3 seconds" })).toBeEnabled();
}

for (const discovery of ["single", "unavailable"]) {
  test(`camera flip stays hidden when device discovery is ${discovery}`, async ({ page }) => {
    await installCameraPreviewFixture(page, () => Promise.resolve("success"));
    await installCameraDevicesFixture(page, 1, discovery === "unavailable");
    await openCapture(page);
    await expect(page.getByRole("button", { name: "Flip camera" })).toHaveCount(0);
    await page.getByRole("button", { name: "Take photo in 3 seconds" }).click();
    await expect(page.getByRole("region", { name: "Photo preview" })).toBeVisible({ timeout: 8_000 });
    await expect(page.locator("html")).toHaveAttribute("data-mirrored-capture", "true");
  });
}

test("camera flip switches both ways and captures the rear camera without mirroring", async ({ page }, testInfo) => {
  await installCameraPreviewFixture(page, () => Promise.resolve("success"));
  await installCameraDevicesFixture(page);
  await openCapture(page);
  const flip = page.getByRole("button", { name: "Flip camera" });
  await expect(flip).toBeEnabled();
  await page.screenshot({ style: "nextjs-portal { visibility: hidden; }", path: testInfo.outputPath("camera-flip-mobile.png") });
  await expect(page.locator("video")).toHaveClass(/-scale-x-100/);
  await page.evaluate(() => { document.documentElement.dataset["holdCameraFlip"] = "true"; });
  await flip.click();
  await expect(flip).toBeDisabled();
  await expect(page.getByRole("button", { name: "Take photo in 3 seconds" })).toHaveCount(0);
  await page.evaluate(() => { document.documentElement.dataset["holdCameraFlip"] = "false"; });
  await expect(flip).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("data-camera-facing", "environment");
  await expect(page.locator("video")).not.toHaveClass(/-scale-x-100/);
  await flip.click();
  await expect(flip).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("data-camera-facing", "user");
  await expect(page.locator("video")).toHaveClass(/-scale-x-100/);
  await flip.click();
  await expect(flip).toBeEnabled();
  await page.getByRole("button", { name: /Photo timer:/ }).click();
  await page.getByRole("button", { name: "Take photo in 5 seconds" }).click();
  await expect(flip).toBeDisabled();
  await expect(page.getByRole("region", { name: "Photo preview" })).toBeVisible({ timeout: 10_000 });
  await expect(flip).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-mirrored-capture", "true");
  await page.getByRole("button", { name: "Retake", exact: true }).click();
  await expect(page.getByRole("button", { name: "Take photo in 5 seconds" })).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("data-camera-facing", "environment");
  await expect(flip).toBeEnabled();
});

for (const failure of ["failCameraFlip", "ignoreCameraFacing"]) {
  test(`camera flip restores the previous camera and allows retry after ${failure}`, async ({ page }) => {
    await installCameraPreviewFixture(page, () => Promise.resolve("success"));
    await installCameraDevicesFixture(page);
    await openCapture(page);
    await page.evaluate(failure => { document.documentElement.dataset[failure] = "true"; }, failure);
    const flip = page.getByRole("button", { name: "Flip camera" });
    await flip.click();
    await expect(page.getByRole("alert").filter({ hasText: "Your previous camera is ready" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Take photo in 3 seconds" })).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute("data-camera-requests", "user,environment,user,");
    await expect(page.locator("video")).toHaveClass(/-scale-x-100/);
    await page.evaluate(failure => { document.documentElement.dataset[failure] = "false"; }, failure);
    await flip.click();
    await expect(flip).toBeEnabled();
    await expect(page.getByRole("alert").filter({ hasText: "Could not switch cameras" })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-camera-facing", "environment");
  });
}

test("camera flip follows camera removal and reconnection", async ({ page }) => {
  await installCameraPreviewFixture(page, () => Promise.resolve("success"));
  await installCameraDevicesFixture(page);
  await openCapture(page);
  const flip = page.getByRole("button", { name: "Flip camera" });
  await expect(flip).toBeEnabled();
  await page.evaluate(() => {
    document.documentElement.dataset["cameraCount"] = "1";
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await expect(flip).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take photo in 3 seconds" })).toBeEnabled();
  await page.evaluate(() => {
    document.documentElement.dataset["cameraCount"] = "2";
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await expect(flip).toBeEnabled();
});

test("leaving capture releases a camera granted after navigation", async ({ page }) => {
  await installCameraPreviewFixture(page, () => Promise.resolve("success"));
  await installCameraDevicesFixture(page);
  await openCapture(page);
  await page.evaluate(() => { document.documentElement.dataset["holdCameraFlip"] = "true"; });
  await page.getByRole("button", { name: "Flip camera" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-camera-stops", "1");
  await page.getByRole("link", { name: "create", exact: true }).click();
  await expect(page).toHaveURL(/\/create$/);
  await page.evaluate(() => { document.documentElement.dataset["holdCameraFlip"] = "false"; });
  await expect(page.locator("html")).toHaveAttribute("data-camera-stops", "2");
  await expect(page.getByRole("button", { name: "Flip camera" })).toHaveCount(0);
});
