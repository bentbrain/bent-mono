import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

// Run with the Browser skill's tab adapter against a production-mode build.
// Start from a cold landing page because visiting /create first warms the router
// cache and can hide a stalled client transition. Keep the real link click.
export async function checkColdCreateNavigation({ tab, origin, linkName }) {
  assert.ok(["create", "Make your own"].includes(linkName));
  const landingUrl = new URL("/", origin).href;
  if (await tab.url() === landingUrl) {
    await tab.reload();
  } else {
    await tab.goto(landingUrl);
  }

  // The automatic colour selection proves the product controls hydrated before
  // the client-routed link is exercised.
  await waitForUrl(tab, (url) => url.searchParams.get("shirtColor") === "Black",
    "landing page did not finish hydrating");

  const before = await tab.dom_cua.get_visible_dom();
  assert.equal(typeof before, "string");
  const link = before.split("\n").find((line) =>
    line.includes('href="/create"') && line.endsWith(`>${linkName}</a>`));
  const nodeId = link?.match(/node_id=(\d+)/)?.[1];
  assert.ok(nodeId, `${linkName} is missing`);
  await tab.dom_cua.click({ node_id: nodeId });

  await waitForUrl(tab, (url) => url.pathname === "/create",
    `${linkName} did not navigate from the cold landing page`);
  const deadline = Date.now() + 10_000;
  let creationVisible = false;
  do {
    const after = await tab.dom_cua.get_visible_dom();
    creationVisible = typeof after === "string" &&
      after.includes('href="/create/camera"');
    if (creationVisible) break;
    await setTimeout(200);
  } while (Date.now() < deadline);
  assert.ok(creationVisible, "creation screen is missing");

  return `PASS: cold landing → ${linkName} → /create`;
}

async function waitForUrl(tab, predicate, message) {
  const deadline = Date.now() + 10_000;
  let currentUrl;
  do {
    currentUrl = await tab.url();
    if (currentUrl && predicate(new URL(currentUrl))) return;
    await setTimeout(200);
  } while (Date.now() < deadline);
  assert.fail(`${message}; current URL: ${currentUrl}`);
}
