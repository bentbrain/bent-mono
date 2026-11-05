import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

void test("auto mode remains mock without local Tesla credentials", () => {
  const config = loadConfig({ TESLA_MODE: "auto", TESLA_TOKEN_FILE: "/missing/tokens.json" });
  assert.equal(config.mode, "mock");
  assert.equal(config.actionsEnabled, true);
});

void test("explicit live access token keeps actions disabled by default", () => {
  const config = loadConfig({ TESLA_MODE: "live", TESLA_ACCESS_TOKEN: "token" });
  assert.equal(config.mode, "live");
  assert.equal(config.actionsEnabled, false);
});
