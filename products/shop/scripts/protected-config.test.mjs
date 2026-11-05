import assert from "node:assert/strict";
import test from "node:test";
import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";

function withConfiguration(encoded, run) {
  const previous = process.env.SHOP_PROTECTED_CONFIG_JSON;
  if (encoded === undefined) delete process.env.SHOP_PROTECTED_CONFIG_JSON;
  else process.env.SHOP_PROTECTED_CONFIG_JSON = encoded;
  try { run(); }
  finally {
    if (previous === undefined) delete process.env.SHOP_PROTECTED_CONFIG_JSON;
    else process.env.SHOP_PROTECTED_CONFIG_JSON = previous;
  }
}

test("missing deployment configuration never selects a default identity", () => {
  withConfiguration(undefined, () => assert.throws(() => protectedConfig("awsAccountId"), /configuration is required/));
});

test("invalid configuration and incomplete identities fail without exposing input", () => {
  withConfiguration("fixture-private-input", () => {
    assert.throws(() => protectedConfig("awsAccountId"), error => {
      assert.match(error.message, /must be a JSON object/);
      assert.ok(!error.message.includes("fixture-private-input"));
      return true;
    });
  });
  for (const value of [null, 12, "", "{{SHOP:unresolved}}"])
    withConfiguration(JSON.stringify({awsAccountId:value}), () => assert.throws(() => protectedConfig("awsAccountId"), /missing awsAccountId/));
  withConfiguration("{}", () => assert.throws(() => protectedConfig("awsAccountId"), /missing awsAccountId/));
});

test("filesystem templates resolve only explicitly supplied protected fields", () => {
  withConfiguration(JSON.stringify({expectedAccount:"configured-fixture"}), () => {
    assert.equal(resolveProtectedTemplate(Buffer.from("target={{SHOP:expectedAccount}}")), "target=configured-fixture");
    assert.equal(resolveProtectedTemplate("no template markers"), "no template markers");
    assert.throws(() => resolveProtectedTemplate("{{SHOP:missingAccount}}"), /missing missingAccount/);
  });
});

test("recovery and inspection identities have no production default", () => {
  for (const key of ["order1003ProviderOrderId", "order1004ProviderOrderId", "order1003ProviderProductId", "alertRecoveryStateBackupVersion", "inspectionProviderOrderId"]) {
    withConfiguration("{}", () => assert.throws(() => protectedConfig(key), /missing/));
    withConfiguration(JSON.stringify({ [key]: "synthetic-identity" }), () => assert.equal(protectedConfig(key), "synthetic-identity"));
  }
});
