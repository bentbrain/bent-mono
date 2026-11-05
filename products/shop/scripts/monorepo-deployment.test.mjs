import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePath, repositoryPath, releaseTree, releaseBlob, PRODUCT_ROOT, REPOSITORY_ROOT } from "./monorepo-source.mjs";
import { renderTerraformModule, renderWranglerConfig, workerProtectedConfiguration, lambdaProtectedConfiguration, wranglerCli } from "./deployment-config.mjs";
import { qualificationPolicy } from "./release-qualification-policy.mjs";
import { changedComponents } from "./deployment-plan.mjs";
import { sealReleaseEvidence, openReleaseEvidence } from "./release-evidence.mjs";
import { writeQualificationPointer } from "./native-qualification-recovery.mjs";
import { activateShopWorkflows, releaseWorkflowNames } from "./activate-workflows.mjs";
import { sealDispatchInputs, resolveDispatchInputs } from "./release-dispatch-inputs.mjs";

test("root and shared source cannot masquerade as Shop leaves or disappear from qualification", () => {
  assert.equal(releasePath("products/shop/apps/web/src/page.tsx"), "apps/web/src/page.tsx");
  for (const path of ["bun.lock", "packages/ui/src/button.tsx", ".github/workflows/quality.yml", "scripts/require-release-checks.mjs"]) {
    const normalized = releasePath(path);
    assert.equal(repositoryPath(normalized), path);
    assert.equal(qualificationPolicy([normalized]).kind, "full");
    assert.deepEqual(changedComponents([normalized]), { web: true, api: true, renderer: true, lambda: true });
  }
  const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  const tree = releaseTree(source);
  assert.ok(tree.includes("\t@monorepo/bun.lock\0"));
  assert.ok(tree.includes("\t@monorepo/packages/ui/package.json\0"));
  assert.ok(tree.includes("\tworkers/api/src/index.ts\0"));
  assert.equal(JSON.parse(releaseBlob(source, "package.json")).name, "@bent/shop-product");
  assert.ok(JSON.parse(releaseBlob(source, "@monorepo/package.json")).workspaces);
});

test("resolved configs are private, source templates stay unchanged, and external Wrangler config retains original path roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-config-"));
  try {
    const source = join(PRODUCT_ROOT, "workers/api/wrangler.jsonc"), before = await readFile(source);
    const result = await renderWranglerConfig(source, join(directory, "api.json"));
    const config = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(config.main, join(PRODUCT_ROOT, "workers/api/src/index.ts"));
    assert.equal(config.env.development.d1_databases[0].migrations_dir, join(PRODUCT_ROOT, "workers/api/drizzle"));
    assert.ok(!JSON.stringify(config).includes("{{SHOP:"));
    assert.deepEqual(await readFile(source), before);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    await assert.rejects(renderWranglerConfig(source, result.path), { code: "EEXIST" });
    const link = join(directory, "link.json");
    await symlink(source, link);
    await assert.rejects(renderWranglerConfig(link, join(directory, "bad.json")));
    assert.ok((await stat(wranglerCli())).isFile());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Terraform rendering keeps both byte manifests and rejects unexpected config or links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-terraform-"));
  try {
    const source = join(directory, "source"); await mkdir(source);
    const original = 'locals { account = "{{SHOP:awsAccountId}}" }\n';
    await writeFile(join(source, "main.tf"), original);
    const rendered = await renderTerraformModule(source, join(directory, "rendered"));
    assert.match(rendered.templateSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(rendered.templateSha256, rendered.resolvedSha256);
    assert.equal(await readFile(join(source, "main.tf"), "utf8"), original);
    assert.ok(!(await readFile(join(rendered.directory, "main.tf"), "utf8")).includes("{{SHOP:"));
    await writeFile(join(source, "override.tf.json"), "{}");
    await assert.rejects(renderTerraformModule(source, join(directory, "bad")));
    await rm(join(source, "override.tf.json")); await rm(join(source, "main.tf"));
    await symlink(join(rendered.directory, "main.tf"), join(source, "main.tf"));
    await assert.rejects(renderTerraformModule(source, join(directory, "linked")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("runtime configuration excludes release evidence, SSO and management context", () => {
  const worker = JSON.parse(workerProtectedConfiguration()), lambda = JSON.parse(lambdaProtectedConfiguration());
  assert.deepEqual(Object.keys(lambda), ["awsAccountId"]);
  for (const key of ["ssoStartUrl", "managementAccountId", "stateKmsKeyId", "evidence_1", "evidence_3"]) assert.equal(Object.hasOwn(worker, key), false);
  assert.ok(worker.githubRepositoryId && worker.order1003ProviderOrderId);
});

const identity = { sourceCommit: "a".repeat(40), runId: "123", filename: "qualification-reference.json" };
const key = { SHOP_EVIDENCE_KEY_VERSION: "v1", SHOP_EVIDENCE_ENCRYPTION_KEY: "07".repeat(32) };
test("operational pointer artifacts authenticate source, run, file and version, with retained-key recovery", () => {
  const privateValue = { key: "private/object/path", version: "private-object-version", sha256: "b".repeat(64) };
  const encoded = sealReleaseEvidence(privateValue, identity, key);
  assert.ok(!encoded.includes(privateValue.key) && !encoded.includes(privateValue.version));
  assert.deepEqual(openReleaseEvidence(encoded, identity, key), privateValue);
  assert.notEqual(encoded, sealReleaseEvidence(privateValue, identity, key));
  for (const delta of [{ runId: "124" }, { sourceCommit: "c".repeat(40) }, { filename: "renderer-reference.json" }]) {
    assert.throws(() => openReleaseEvidence(encoded, { ...identity, ...delta }, key));
  }
  for (const field of ["nonce", "ciphertext", "tag", "keyVersion", "repository"]) {
    const value = JSON.parse(encoded); value[field] = field === "keyVersion" ? "v2" : "changed";
    assert.throws(() => openReleaseEvidence(JSON.stringify(value), identity, key));
  }
  const rotated = { SHOP_EVIDENCE_KEY_VERSION: "v2", SHOP_EVIDENCE_ENCRYPTION_KEY: "08".repeat(32), SHOP_EVIDENCE_PREVIOUS_KEYS_JSON: JSON.stringify({ v1: key.SHOP_EVIDENCE_ENCRYPTION_KEY }) };
  assert.deepEqual(openReleaseEvidence(encoded, identity, rotated), privateValue);
  assert.throws(() => openReleaseEvidence(encoded, identity, { ...rotated, SHOP_EVIDENCE_PREVIOUS_KEYS_JSON: "" }));
  assert.throws(() => sealReleaseEvidence(privateValue, identity, { ...key, SHOP_EVIDENCE_ENCRYPTION_KEY: "08" }));
  assert.throws(() => openReleaseEvidence(encoded, identity, { ...key, SHOP_EVIDENCE_PREVIOUS_KEYS_JSON: JSON.stringify({ v1: "08".repeat(32) }) }));
  assert.throws(() => openReleaseEvidence(JSON.stringify(privateValue), identity, key));
});

test("qualification emits encrypted transport that requires the same protected route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-pointer-"));
  try {
    const value = { key: "private", version: "immutable", sha256: "b".repeat(64) };
    await writeQualificationPointer({ RUNNER_TEMP: directory, GITHUB_SHA: identity.sourceCommit, GITHUB_RUN_ID: identity.runId }, value);
    const text = await readFile(join(directory, identity.filename), "utf8");
    assert.deepEqual(openReleaseEvidence(text, identity), value);
    assert.equal(text.includes('"version":"immutable"'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("workflow activation excludes incident recoveries and detects drift without overwriting unrelated workflows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-workflows-"));
  try {
    const files = await activateShopWorkflows({ check: false, destination: directory });
    assert.equal(files.length, 8);
    assert.ok(releaseWorkflowNames.every(name => !name.includes("recovery") && !name.includes("schedule")));
    await activateShopWorkflows({ destination: directory });
    await assert.rejects(activateShopWorkflows({ check: false, destination: directory }), { code: "EEXIST" });
    await writeFile(join(directory, "native-production.yml"), "changed guard");
    await assert.rejects(activateShopWorkflows({ destination: directory }), /differs from its reviewed source/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dispatch inputs remain ciphertext in GitHub and require their exact source, purpose and original evidence run", () => {
  const input = { qualification_reference: JSON.stringify({ key: "source/releases/native-100/qualification-complete-summary-native-200-run-300.json", version: "private-version" }), expected_source: identity.sourceCommit };
  const sealed = sealDispatchInputs(input, identity.sourceCommit, key);
  assert.equal(sealed.expected_source, identity.sourceCommit);
  assert.equal(sealed.qualification_reference.includes("private-version"), false);
  const env = { ...key, GITHUB_SHA: identity.sourceCommit, NATIVE_QUALIFICATION_REFERENCE: sealed.qualification_reference };
  resolveDispatchInputs(env);
  assert.equal(env.NATIVE_QUALIFICATION_REFERENCE, input.qualification_reference);
  assert.throws(() => resolveDispatchInputs({ ...key, GITHUB_SHA: "b".repeat(40), NATIVE_QUALIFICATION_REFERENCE: sealed.qualification_reference }));
  assert.throws(() => resolveDispatchInputs({ ...key, GITHUB_SHA: identity.sourceCommit, NATIVE_RENDERER_REFERENCE: sealed.qualification_reference }));
  assert.throws(() => resolveDispatchInputs({ ...key, GITHUB_SHA: identity.sourceCommit, NATIVE_QUALIFICATION_REFERENCE: input.qualification_reference }));
});
