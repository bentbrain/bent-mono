import { test } from "node:test";
import assert from "node:assert/strict";
import { launchSearch } from "../lib/launch-search.ts";
await test("upload and camera handoffs survive parsed and serialized Start query values", () => {
  for (const value of ["1", 1, true]) {
    const parsed = launchSearch({ upload: value, camera: value });
    assert.deepEqual(parsed, { upload: true, camera: true });
    assert.deepEqual(launchSearch(parsed), parsed);
  }
  for (const value of [undefined, null, "0", 0, false, "false"])
    assert.deepEqual(launchSearch({ upload: value, camera: value }), {
      upload: false,
      camera: false,
    });
});
