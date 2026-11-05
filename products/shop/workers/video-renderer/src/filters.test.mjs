import assert from "node:assert/strict";
import test from "node:test";
import { storyVideoFilters } from "./renderer.mjs";

const options = {
  frameWidth: 720, frameHeight: 1280,
  holdDurationSeconds: 8 - 91 / 30,
  cursorPosition: { x: 518, y: 1014 }, cursorStartSeconds: 3,
};

test("keeps the deployed filter order as the default and rollback", () => {
  const { filters, outputLabel } = storyVideoFilters(options);
  assert.equal(outputLabel, "video");
  assert.deepEqual(filters, [
    "[0:v]tpad=stop_mode=clone:stop_duration=4.966666666666667[held]",
    "[held][1:v]overlay=518:1014:enable='gte(t\\,3)*lt(mod(t\\,1)\\,0.5)':shortest=1[composed]",
    "[composed]scale=1080:1920:flags=lanczos[video]",
  ]);
});

test("the experiment scales only unique scene frames before the hold", () => {
  const { filters, outputLabel } = storyVideoFilters({ ...options, scaleBeforeHold: true });
  assert.equal(outputLabel, "composed");
  assert.equal(filters[0], "[0:v]scale=1080:1920:flags=lanczos[scaled]");
  assert.match(filters[1], /^\[scaled\]tpad=/);
  assert.equal(filters[2], "[1:v]scale=iw*1.5:ih*1.5:flags=lanczos[cursor]");
  assert.equal(filters[3], "[held][cursor]overlay=777:1521:enable='gte(t\\,3)*lt(mod(t\\,1)\\,0.5)':shortest=1[composed]");
});

test("native 1080p needs no scaling in either mode", () => {
  for (const scaleBeforeHold of [false, true]) {
    const { filters, outputLabel } = storyVideoFilters({
      ...options, frameWidth: 1080, frameHeight: 1920, scaleBeforeHold,
    });
    assert.equal(outputLabel, "composed");
    assert.equal(filters.length, 2);
    assert.ok(filters.every(filter => !filter.includes("scale=")));
  }
});
