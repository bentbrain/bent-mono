import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";

test("every inventoried bent.build application has source and a shared design dependency", () => {
  const { applications } = JSON.parse(readFileSync("deployments.json", "utf8"));
  assert.equal(applications.length, 9);
  const domains = new Set();
  for (const application of applications) {
    assert.ok(existsSync(`${application.directory}/package.json`), application.name);
    const manifest = JSON.parse(readFileSync(`${application.directory}/package.json`, "utf8"));
    assert.equal(manifest.dependencies["@bent/design-tokens"], "workspace:*");
    for (const domain of application.domains) {
      assert.ok(domain === "bent.build" || domain.endsWith(".bent.build"));
      assert.ok(!domains.has(domain), domain);
      domains.add(domain);
    }
    assert.ok(!/emoji|hand-shake|middle-finger/.test(application.directory));
  }
});

test("public imports have provenance without importing private histories", () => {
  const { imports } = JSON.parse(readFileSync("SOURCE_PROVENANCE.json", "utf8"));
  assert.equal(imports.length, 8);
  for (const source of imports) {
    assert.match(source.revision, /^[a-f0-9]{40}$/);
    assert.ok(!existsSync(`${source.destination}/.git`));
  }
});
