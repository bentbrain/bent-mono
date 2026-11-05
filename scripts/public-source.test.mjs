import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sourceProblems } from "./check-public-source.mjs";
import { syntheticEvidenceDocuments } from "../products/shop/scripts/synthetic-evidence.mjs";

const fixturePath = "products/shop/scripts/protected-config.fixtures.json";
const shopFixtures = JSON.parse(readFileSync(new URL(`../${fixturePath}`, import.meta.url), "utf8"));

test("private runtime files cannot enter the public repository", () => {
  for (const path of ["apps/stay/.env.local", "apps/jp/.dev.vars", "apps/collage/.clerk/keys.json", "products/shop/infra/private.tfvars", "private/content.json", "apps/home/.vercel/project.json", "products/shop/infra/state.tfstate", "apps/collage/migration-artifacts/export.json"]) {
    assert.ok(sourceProblems(path, "").length > 0, path);
  }
});

test("safe examples and the isolated renderer lock retain supported build inputs", () => {
  for (const path of ["apps/stay/.env.example", "products/shop/infra/config.tfvars.example", "products/shop/workers/api/.dev.vars.example", "bun.lock", "products/shop/workers/video-renderer/aws-lambda/package-lock.json"]) {
    assert.deepEqual(sourceProblems(path, ""), [], path);
  }
  assert.ok(sourceProblems("apps/jp/bun.lock", "").length > 0);
});

test("public certificates are permitted and private keys are rejected", () => {
  assert.deepEqual(sourceProblems("public/tesla.pem", "-----BEGIN PUBLIC KEY-----"), []);
  assert.ok(sourceProblems("key.pem", "-----BEGIN " + "PRIVATE KEY-----").length > 0);
});

test("operational recovery identities require protected configuration while synthetic fixtures remain public", () => {
  for (const [path, contents] of [
    ["products/shop/workers/api/src/paid-order-provider-recovery.ts", 'providerOrderId: "synthetic-provider-order"'],
    ["products/shop/scripts/paid-order-provider-recovery.mjs", "providerOrderId: 'synthetic-provider-order'"],
    ["products/shop/workers/api/src/paid-order-product-recovery.ts", 'providerProductId: "synthetic-provider-product"'],
    ["products/shop/scripts/paid-order-product-recovery.mjs", 'providerProductId: "synthetic-provider-product"'],
    ["products/shop/scripts/native-production-alert-recovery.mjs", 'backup: { version: "synthetic-backup-version" }'],
  ]) {
    assert.ok(sourceProblems(path, contents).includes("literal operational recovery identity must use protected configuration"), path);
    assert.deepEqual(sourceProblems(path, 'providerOrderId: protectedConfig("order1003ProviderOrderId")'), [], path);
  }
  assert.deepEqual(sourceProblems("products/shop/scripts/paid-order-provider-recovery.test.mjs", 'providerOrderId: "synthetic-provider-order"'), []);
  assert.deepEqual(sourceProblems(fixturePath, JSON.stringify({ ...shopFixtures, order1003ProviderOrderId: "synthetic-provider-order" })), []);
});

test("every embedded evidence field must remain explicitly synthetic", () => {
  const leaves = (value, path = []) => value !== null && typeof value === "object"
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]))
    : [{ path, value }];
  assert.deepEqual(sourceProblems(fixturePath, JSON.stringify(shopFixtures)), []);
  for (const [key, document] of Object.entries(syntheticEvidenceDocuments)) {
    assert.deepEqual(JSON.parse(shopFixtures[key]), document, key);
    for (const { path, value } of leaves(document)) {
      const changed = structuredClone(document);
      const parent = path.slice(0, -1).reduce((item, part) => item[part], changed);
      parent[path.at(-1)] = typeof value === "string" ? "injected-operational-value" : typeof value === "number" ? value + 1 : !value;
      const fixtures = { ...shopFixtures, [key]: JSON.stringify(changed) };
      assert.ok(sourceProblems(fixturePath, JSON.stringify(fixtures)).includes("embedded evidence must match the explicit synthetic documents"), `${key}.${path.join(".")}`);
    }
  }
  assert.ok(sourceProblems(fixturePath, JSON.stringify({ ...shopFixtures, evidence_1: "not-json" })).length > 0);
  assert.ok(sourceProblems(fixturePath, JSON.stringify({ ...shopFixtures, evidence_6: "{}" })).length > 0);
});

test("inspection provider identities require protected script configuration and workflow templates", () => {
  const script = "products/shop/scripts/inspect-printify-order.mjs";
  const workflow = "products/shop/.github/workflows/inspect-printify-order.yml";
  assert.ok(sourceProblems(script, 'env.PRINTIFY_ORDER_ID !== "synthetic-provider-order"').length > 0);
  assert.ok(sourceProblems(workflow, "PRINTIFY_ORDER_ID: 'synthetic-provider-order'").length > 0);
  assert.deepEqual(sourceProblems(script, 'env.PRINTIFY_ORDER_ID !== protectedConfig("inspectionProviderOrderId")'), []);
  assert.deepEqual(sourceProblems(workflow, 'PRINTIFY_ORDER_ID: "{{SHOP:inspectionProviderOrderId}}"'), []);
});
