import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "./test";

const resolveModule = createRequire(resolve("package.json")).resolve;

function expandReplay(value: unknown): unknown {
  if (typeof value === "string" && value.charCodeAt(0) === 31 && value.charCodeAt(1) === 139) {
    return expandReplay(JSON.parse(gunzipSync(Buffer.from(value, "latin1")).toString()));
  }
  if (Array.isArray(value)) return value.map(expandReplay);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandReplay(item)]));
  return value;
}

function replaySnapshots(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(replaySnapshots);
  if (!value || typeof value !== "object") return [];
  if ("$snapshot_data" in value && Array.isArray(value.$snapshot_data)) return value.$snapshot_data;
  return Object.values(value).flatMap(replaySnapshots);
}

test("real SDK sends pageviews, interactions, errors and masked replay", async ({ page, context }, testInfo) => {
  const events: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
  });
  await page.route("https://analytics.example.com/**", async (route) => {
    const url = new URL(route.request().url());
    const buffer = route.request().postDataBuffer();
    if (buffer) {
      const text = buffer[0] === 31 && buffer[1] === 139 ? gunzipSync(buffer).toString() : buffer.toString();
      const json = text.startsWith("data=") ? Buffer.from(new URLSearchParams(text).get("data") ?? "", "base64").toString() : text;
      events.push(JSON.stringify(expandReplay(JSON.parse(json))));
    }
    if (url.pathname.endsWith(".js")) {
      const file = url.pathname.split("/").pop();
      if (file === "config.js") return route.abort();
      if (file && ["recorder.js", "recorder-v2.js", "posthog-recorder.js", "lazy-recorder.js", "exception-autocapture.js"].includes(file)) {
        return route.fulfill({ path: resolveModule(`posthog-js/dist/${file}`), contentType: "application/javascript" });
      }
      return route.fulfill({ contentType: "application/javascript", body: "" });
    }
    if (url.pathname.includes("flags") || url.pathname.endsWith("/config")) {
      return route.fulfill({ json: {
        featureFlags: {}, sessionRecording: { endpoint: "/s/", minimumDurationMilliseconds: 0 },
        autocaptureExceptions: true, autocapture_opt_out: false, supportedCompression: [],
      } });
    }
    return route.fulfill({ json: { status: 1 } });
  });

  await page.goto("/create?token=PRIVATE_QUERY#PRIVATE_FRAGMENT");
  await expect.poll(() => events.join("\n")).toContain("$pageview");
  await page.getByRole("link", { name: "Privacy", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect.poll(() => events.join("\n")).toContain("$autocapture");
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.value = "PRIVATE_INPUT";
    const text = document.createElement("p");
    text.className = "posthog-privacy-fixture ph-mask";
    text.textContent = "PRIVATE_TEXT";
    const image = document.createElement("img");
    image.src = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><text>PRIVATE_PORTRAIT</text></svg>";
    const publicText = document.createElement("p");
    publicText.className = "posthog-public-fixture flex";
    publicText.textContent = "Public replay label";
    const alert = document.createElement("p");
    alert.setAttribute("role", "alert");
    alert.textContent = "PRIVATE_ALERT";
    document.body.append(input, text, image, publicText, alert);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => {
    setTimeout(() => { throw new Error("PRIVATE_ERROR_MESSAGE"); }, 0);
    void Promise.reject(new Error("PRIVATE_REJECTION"));
  });
  // Replay metadata can mention $exception before queued exception events arrive.
  // Wait for both actual events, including a later SDK batch.
  await expect.poll(() => events.join("\n").match(/"event":"\$exception"/g)?.length ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => events.join("\n"), { timeout: 15_000 }).toContain("$snapshot");
  await expect.poll(() => events.join("\n"), { timeout: 15_000 }).toContain("posthog-privacy-fixture");
  await expect.poll(() => events.join("\n")).toContain("Public replay label");
  await expect.poll(() => events.join("\n")).toContain("_cssText");
  expect(events.join("\n")).not.toMatch(/PRIVATE_QUERY|PRIVATE_FRAGMENT|PRIVATE_ERROR_MESSAGE|PRIVATE_REJECTION|PRIVATE_INPUT|PRIVATE_TEXT|PRIVATE_PORTRAIT|PRIVATE_ALERT/);

  const bodyStyles = await page.locator("body").evaluate((body) => ({
    color: getComputedStyle(body).color,
    fontFamily: getComputedStyle(body).fontFamily,
  }));
  const snapshots = events.flatMap((event) => replaySnapshots(JSON.parse(event)));
  const replay = await context.newPage();
  await replay.route("**/posthog-replay", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
  await replay.route("**/test-rrweb.js", (route) => route.fulfill({ path: resolveModule("posthog-js/dist/rrweb.js"), contentType: "application/javascript" }));
  await replay.goto(new URL("/posthog-replay", page.url()).href);
  await replay.addScriptTag({ type: "module", content: `
    import { Replayer } from "/test-rrweb.js";
    const events = ${JSON.stringify(snapshots)};
    const player = new Replayer(events, { root: document.body, showWarning: false });
    player.pause(events.at(-1).timestamp - events[0].timestamp + 1);
  ` });
  const recorded = replay.frameLocator(".replayer-wrapper iframe");
  await expect(recorded.locator(".posthog-public-fixture")).toHaveText("Public replay label");
  await expect(recorded.locator(".posthog-public-fixture")).toHaveCSS("display", "flex");
  await expect(recorded.locator("body")).toHaveCSS("color", bodyStyles.color);
  await expect(recorded.locator("body")).toHaveCSS("font-family", bodyStyles.fontFamily);
  await expect(recorded.locator(".posthog-privacy-fixture")).not.toContainText("PRIVATE_TEXT");
  await testInfo.attach("styled-replay", { body: await replay.screenshot(), contentType: "image/png" });
  await replay.close();
});

test("direct Manage order entry makes no PostHog requests", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "analytics.example.com") requests.push(request.url());
  });
  await page.goto("/manage-order?token=PRIVATE_ORDER");
  await expect(page.getByRole("heading", { name: "Manage order" })).toBeVisible();
  expect(requests).toEqual([]);
});
