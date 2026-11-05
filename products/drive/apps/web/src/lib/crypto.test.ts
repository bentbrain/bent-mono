import assert from "node:assert/strict";
import test from "node:test";

import { open, pkceChallenge, seal, verifyPkce } from "./crypto";

const key = Buffer.alloc(32, 7).toString("base64url");

void test("sealed values round-trip and do not expose plaintext", () => {
  const encrypted = seal("refresh-token", key);
  assert.equal(encrypted.includes("refresh-token"), false);
  assert.equal(open(encrypted, key), "refresh-token");
});

void test("sealed values reject authenticated-ciphertext tampering", () => {
  const encrypted = seal("refresh-token", key);
  const parts = encrypted.split(".");
  const ciphertext = parts.at(2);
  assert.notEqual(ciphertext, undefined);
  const replacement = ciphertext?.startsWith("A") ? "B" : "A";
  parts[2] = `${replacement}${ciphertext?.slice(1)}`;
  assert.throws(() => open(parts.join("."), key));
});

void test("PKCE accepts only the matching verifier", () => {
  const verifier = "a-secure-verifier-with-more-than-forty-three-characters";
  const challenge = pkceChallenge(verifier);
  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce(`${verifier}-wrong`, challenge), false);
});
