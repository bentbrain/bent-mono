import assert from "node:assert/strict";
import test from "node:test";

import {
  hasDuplicateParameters,
  isAllowedOAuthRedirect,
  normalizeRequestedScopes,
} from "./oauth";

void test("OAuth redirect allowlist accepts ChatGPT callbacks", () => {
  assert.equal(
    isAllowedOAuthRedirect("https://chatgpt.com/connector/oauth/example-callback", false),
    true
  );
  assert.equal(isAllowedOAuthRedirect("https://attacker.example/callback", false), false);
});

void test("OAuth redirect allowlist rejects deceptive hosts and path prefixes", () => {
  assert.equal(
    isAllowedOAuthRedirect("https://chatgpt.com.attacker.example/connector/oauth/callback", false),
    false
  );
  assert.equal(
    isAllowedOAuthRedirect("https://chatgpt.com/connector/oauthish/callback", false),
    false
  );
});

void test("local redirects require an explicit development flag", () => {
  assert.equal(isAllowedOAuthRedirect("http://127.0.0.1:6274/callback", false), false);
  assert.equal(isAllowedOAuthRedirect("http://127.0.0.1:6274/callback", true), true);
  assert.equal(isAllowedOAuthRedirect("http://localhost.attacker.example/callback", true), false);
  assert.equal(isAllowedOAuthRedirect("ftp://localhost/callback", true), false);
});

void test("the hosted service only grants its read scope", () => {
  assert.equal(normalizeRequestedScopes(undefined), "tesla.read");
  assert.throws(() => normalizeRequestedScopes("tesla.actions"), /unsupported/);
});

void test("OAuth resource may repeat only when every value is identical", () => {
  const repeatedResource = new URLSearchParams([
    ["resource", "https://drive.bent.build/mcp"],
    ["resource", "https://drive.bent.build/mcp"],
  ]);
  assert.equal(hasDuplicateParameters(repeatedResource, ["resource"]), false);

  repeatedResource.set("state", "first");
  repeatedResource.append("state", "first");
  assert.equal(hasDuplicateParameters(repeatedResource, ["resource"]), true);

  const conflictingResources = new URLSearchParams([
    ["resource", "https://drive.bent.build/mcp"],
    ["resource", "https://attacker.example/mcp"],
  ]);
  assert.equal(hasDuplicateParameters(conflictingResources, ["resource"]), true);
});
