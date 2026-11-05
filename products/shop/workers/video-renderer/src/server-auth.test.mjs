import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAuthorized } from "./server-auth.mjs";

describe("renderer authorization", () => {
  it("accepts only the configured bearer token", () => {
    assert.equal(isAuthorized("Bearer benchmark-secret", "benchmark-secret"), true);
    assert.equal(isAuthorized("Bearer wrong", "benchmark-secret"), false);
    assert.equal(isAuthorized(undefined, "benchmark-secret"), false);
    assert.equal(isAuthorized("Bearer benchmark-secret", undefined), false);
  });
});
