import assert from "node:assert/strict";
import test from "node:test";

import { isGithubAccount } from "./identity";

void test("accepts Clerk's GitHub provider identifiers", () => {
  assert.equal(isGithubAccount({ provider: "oauth_github" }), true);
  assert.equal(isGithubAccount({ provider: "github" }), true);
});

void test("rejects non-GitHub accounts", () => {
  assert.equal(isGithubAccount({ provider: "oauth_google" }), false);
});
