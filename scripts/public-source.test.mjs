import assert from "node:assert/strict";
import test from "node:test";
import { sourceProblems } from "./check-public-source.mjs";

test("private runtime files cannot enter the public repository", () => {
  for (const path of [
    "apps/stay/.env.local",
    "apps/jp/.dev.vars",
    "apps/collage/.clerk/keys.json",
    "infra/private.tfvars",
    "private/content.json",
    "apps/home/.vercel/project.json",
    "infra/state.tfstate",
    "apps/collage/migration-artifacts/export.json",
  ]) {
    assert.ok(sourceProblems(path, "").length > 0, path);
  }
});

test("safe examples and the single workspace lock remain supported", () => {
  for (const path of [
    "apps/stay/.env.example",
    "infra/config.tfvars.example",
    "apps/toolbar/.dev.vars.example",
    "bun.lock",
  ]) {
    assert.deepEqual(sourceProblems(path, ""), [], path);
  }
  for (const path of [
    "apps/jp/bun.lock",
    "apps/www/package-lock.json",
    "pnpm-lock.yaml",
  ]) {
    assert.ok(sourceProblems(path, "").length > 0, path);
  }
});

test("public certificates are permitted and private keys are rejected", () => {
  assert.deepEqual(
    sourceProblems("public/tesla.pem", "-----BEGIN PUBLIC KEY-----"),
    [],
  );
  assert.ok(
    sourceProblems("key.pem", "-----BEGIN " + "PRIVATE KEY-----").length > 0,
  );
});

test("personal paths remain private while synthetic filesystem examples are allowed", () => {
  assert.ok(
    sourceProblems("example.txt", "/Users/" + "someone/secret.txt").length > 0,
  );
  assert.deepEqual(
    sourceProblems("example.txt", "/Users/example/file.txt"),
    [],
  );
});
