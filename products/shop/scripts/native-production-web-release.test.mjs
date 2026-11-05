import test from "node:test";
import assert from "node:assert/strict";
import { verifyWebProject, verifyStagedWebDeployment, verifyProductionWebEnvironment, verifyProductionWebEnvironmentMetadata, executeStorefrontPromotion, existingWebAutomationCredential } from "./native-production-web-release.mjs";
const project = { id: "prj_qJ3JwcSlVixLNHRxfwnvfxp8dMBS", accountId: "team_ru36uQa1rhHA6N5wW0lblUkz", name: "forever-tee-web", rootDirectory: "products/shop/apps/web" };
const deployment = { id: "dpl_staged", projectId: project.id, team: { id: project.accountId }, target: "production", readyState: "READY", source: "cli",
  meta: { githubCommitSha: "a".repeat(40), nativeProductionSource: "a".repeat(40) }, url: "forever-tee-fixture-bentbrains-projects.vercel.app", alias: [] };
test("staged access requires one existing automation credential and never changes protection", () => {
  const token = "synthetic-existing-automation-secret";
  assert.equal(existingWebAutomationCredential({ ...project, protectionBypass: { [token]: { scope: "automation-bypass" } } }), token);
  for (const protectionBypass of [undefined, {}, { [token]: { scope: "shareable-link" } }, { [token]: { scope: "automation-bypass" }, [token + "2"]: { scope: "automation-bypass" } }])
    assert.throws(() => existingWebAutomationCredential({ ...project, protectionBypass }));
});
test("storefront promotion pins personal project, immutable source and unpromoted build", () => {
  verifyWebProject(project); verifyStagedWebDeployment(deployment, "a".repeat(40));
  for (const delta of [{ accountId: "work" }, { id: "other" }, { link: {} }, { rootDirectory: "other" }]) assert.throws(() => verifyWebProject({ ...project, ...delta }));
  for (const delta of [{ projectId: "other" }, { team: { id: "work" } }, { readyState: "BUILDING" }, { source: "git" }, { target: "preview" },
    { meta: { githubCommitSha: "b".repeat(40) } }, { alias: ["shop.bent.build"] }, { url: "evil.example" }])
    assert.throws(() => verifyStagedWebDeployment({ ...deployment, ...delta }, "a".repeat(40)));
});
test("staged Production build cannot use Development API or Preview challenge credentials", () => {
  const env = { FOREVER_TEE_API_URL: "https://forever-tee-api.socialqueue.workers.dev", FOREVER_TEE_API_SHARED_SECRET: "fixture-secret",
    NEXT_PUBLIC_FOREVER_TEE_API_URL: "https://forever-tee-api.socialqueue.workers.dev", FOREVER_TEE_ENFORCE_WORKER_RELEASE: "1",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "real-fixture-site-key", TURNSTILE_SECRET: "real-fixture-secret" };
  verifyProductionWebEnvironment(env, "fixture-secret");
  verifyProductionWebEnvironment({ ...env, FOREVER_TEE_API_SHARED_SECRET: "[SENSITIVE]", FOREVER_TEE_ENFORCE_WORKER_RELEASE: "[SENSITIVE]",
    TURNSTILE_SECRET: "[SENSITIVE]" }, "fixture-secret");
  for (const delta of [{ FOREVER_TEE_API_URL: "https://development.example" }, { FOREVER_TEE_API_SHARED_SECRET: "other" }, { FOREVER_TEE_ENFORCE_WORKER_RELEASE: undefined },
    { NEXT_PUBLIC_FOREVER_TEE_API_URL: "https://development.example" }, { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "[SENSITIVE]" },
    { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }, { TURNSTILE_SECRET: "1x0000000000000000000000000000000AA" }, { TURNSTILE_TEST_MODE: "1" }])
    assert.throws(() => verifyProductionWebEnvironment({ ...env, ...delta }, "fixture-secret"));
});
test("remote Production environment metadata pins each binding and forbids test mode", () => {
  const entries = [
    ["FOREVER_TEE_API_SHARED_SECRET", "sensitive", 1786839353918, 1787466006947],
    ["FOREVER_TEE_API_URL", "encrypted", 1786569311079, 1787465955772],
    ["FOREVER_TEE_ENFORCE_WORKER_RELEASE", "sensitive", 1786842484938, 1786842484938],
    ["NEXT_PUBLIC_FOREVER_TEE_API_URL", "encrypted", 1786569311079, 1787465958405],
    ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "encrypted", 1786839462886, 1786839462886],
    ["TURNSTILE_SECRET", "sensitive", 1786839408060, 1786843550230],
  ];
  const metadata = { envs: entries.map(([key, type, createdAt, updatedAt]) => ({ key, type, createdAt, updatedAt, target: ["production"], configurationId: null })) };
  verifyProductionWebEnvironmentMetadata(metadata);
  for (const mutate of [value => { value.envs[0].type = "encrypted"; }, value => { value.envs[1].updatedAt++; },
    value => { value.envs[2].target.push("preview"); }, value => { value.envs.push({ key: "TURNSTILE_TEST_MODE", target: ["production"] }); }]) {
    const changed = structuredClone(metadata); mutate(changed); assert.throws(() => verifyProductionWebEnvironmentMetadata(changed));
  }
});
function fixture() {
  const events = []; let current = "dpl_old";
  return { events, args: { previous: { id: current },
    save: async name => { events.push(name); }, verifyPair: async () => { events.push("pair"); },
    deploy: async () => { events.push("deploy"); return "url"; }, inspectStaged: async () => ({ id: "dpl_staged", url: "url" }),
    domain: async () => current, canary: async () => { events.push("canary"); return { productionCanaryPassed: true, storefrontBffVerified: true, videos: 4, evidence: "saved" }; },
    promote: async id => { events.push("promote"); current = id; }, publicCheck: async () => { events.push("public"); },
  } };
}
test("promotion is preceded by durable intent and real staged BFF checks", async () => {
  const f = fixture(); const result = await executeStorefrontPromotion(f.args);
  assert.equal(result.productionStorefrontReleased, true);
  assert.deepEqual(f.events, ["storefront-before.json", "pair", "storefront-build-intent.json", "deploy", "storefront-staged.json", "canary", "pair",
    "storefront-promote-intent.json", "promote", "public", "storefront-complete.json"]);
});
test("failed canary, changed domain or uncertain deploy never promotes or retries", async () => {
  for (const change of [
    { canary: async () => { throw Error("failed canary"); } },
    { domain: async () => "dpl_someone_else" },
    { deploy: async () => { throw Error("lost response"); } },
    { canary: async () => ({ productionCanaryPassed: true, storefrontBffVerified: false, videos: 4 }) },
  ]) {
    const f = fixture(); await assert.rejects(executeStorefrontPromotion({ ...f.args, ...change }));
    assert.equal(f.events.includes("promote"), false); assert.equal(f.events.includes("storefront-complete.json"), false);
  }
});
test("uncertain promotion retains intent and never reports completion or retries", async () => {
  const f = fixture(); let count = 0;
  await assert.rejects(executeStorefrontPromotion({ ...f.args, promote: async () => { count++; throw Error("lost response"); } }));
  assert.equal(count, 1); assert.equal(f.events.includes("storefront-promote-intent.json"), true); assert.equal(f.events.includes("storefront-complete.json"), false);
});
