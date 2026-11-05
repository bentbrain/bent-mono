import assert from "node:assert/strict";
import test from "node:test";
import { localBrowserCommands } from "../apps/web/scripts/local-browser.mjs";

test("browser shards cover the local suite and run the separate analytics server exactly once", () => {
  const first = localBrowserCommands({ PLAYWRIGHT_SHARD: "1/2" });
  const second = localBrowserCommands({ PLAYWRIGHT_SHARD: "2/2" });
  assert.equal(first.length, 2);
  assert.equal(second.length, 1);
  assert.ok(first[0].includes("--shard=1/2"));
  assert.ok(second[0].includes("--shard=2/2"));
  assert.ok(first[1].includes("playwright.posthog.config.ts"));
  assert.ok(!first[1].some(value => value.startsWith("--shard=")));
  assert.equal(localBrowserCommands({}).length, 2);
  for (const shard of ["0/2", "3/2", "1/65", "1/2 --grep=skip", "NaN/2"])
    assert.throws(() => localBrowserCommands({ PLAYWRIGHT_SHARD: shard }), /Invalid browser shard/);
});
