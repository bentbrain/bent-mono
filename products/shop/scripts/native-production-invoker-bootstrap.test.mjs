import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapProductionInvoker, PRODUCTION_INVOKER, PRODUCTION_NATIVE_SECRET_NAMES } from "./native-production-invoker-bootstrap.mjs";
import { validatePersonalArguments } from "./aws-personal-guard.mjs";

function fixture() {
  const state = { keys: [], names: [], transfers: new Map(), calls: [] };
  const key = { UserName: PRODUCTION_INVOKER, Status: "Active", AccessKeyId: `AKIA${"A".repeat(16)}`, SecretAccessKey: "B".repeat(40) };
  const dependencies = {
    verifyIdentity: async () => { state.calls.push("verify"); },
    readKeys: async () => ({ AccessKeyMetadata: state.keys }), readSecretNames: async () => [...state.names],
    loadIntent: async () => state.intent, loadCredentials: async () => state.credentials,
    createIntent: async value => { assert.equal(state.intent, undefined); state.intent = value; state.calls.push("intent"); },
    createKey: async () => { assert.equal(state.intent.state, "creating"); state.calls.push("create"); state.keys = [{ UserName: key.UserName, Status: key.Status, AccessKeyId: key.AccessKeyId }]; return { AccessKey: key }; },
    saveCredentials: async value => { assert.equal(state.credentials, undefined); state.calls.push("save"); state.credentials = value; },
    loadTransfer: async name => state.transfers.get(name), beginTransfer: async (name, value) => { state.transfers.set(name, value); state.calls.push(`intent:${name}`); },
    setSecret: async (name, value) => { assert.equal(value, state.credentials[name]); assert.equal(state.transfers.get(name), value); state.names = [...new Set([...state.names, name])]; state.calls.push(`set:${name}`); },
    acknowledgeTransfer: async name => { state.calls.push(`ack:${name}`); }, complete: async () => { state.calls.push("complete"); },
  };
  return { state, dependencies };
}
test("Production key creation persists intent and complete credentials before transferring only protected GitHub secrets", async () => {
  const { state, dependencies } = fixture();
  const result = await bootstrapProductionInvoker("prepare", dependencies);
  assert.deepEqual(state.calls.slice(0, 4), ["verify", "intent", "create", "save"]);
  assert.deepEqual(state.names, PRODUCTION_NATIVE_SECRET_NAMES);
  assert.equal(result.cloudflareSecretsChanged, false); assert.equal(result.applicationDeployment, false);
  assert.equal(state.calls.filter(value => value === "create").length, 1);
  await assert.rejects(bootstrapProductionInvoker("prepare", dependencies), /fresh bootstrap/);
});
test("uncertain AWS creation with no saved key can never trigger automatic replacement", async () => {
  const { state, dependencies } = fixture();
  dependencies.createKey = async () => { state.calls.push("create"); throw new Error("lost response"); };
  await assert.rejects(bootstrapProductionInvoker("prepare", dependencies), /lost response/);
  await assert.rejects(bootstrapProductionInvoker("resume", dependencies), /interrupted creation/);
  await assert.rejects(bootstrapProductionInvoker("prepare", dependencies), /fresh bootstrap/);
  assert.equal(state.calls.filter(value => value === "create").length, 1);
});
test("an uncertain GitHub transfer resumes with the same saved key and journaled values", async () => {
  const { state, dependencies } = fixture(), original = dependencies.setSecret;
  let fail = true;
  dependencies.setSecret = async (...args) => { await original(...args); if (fail) { fail = false; throw Error("lost GitHub response"); } };
  await assert.rejects(bootstrapProductionInvoker("prepare", dependencies), /lost GitHub/);
  const previous = structuredClone(state.credentials);
  await bootstrapProductionInvoker("resume", dependencies);
  assert.deepEqual(state.credentials, previous); assert.equal(state.calls.filter(value => value === "create").length, 1);
});
test("existing keys or unowned GitHub destinations stop before creation or overwrite", async () => {
  for (const setup of [state => { state.keys = [{}]; }, state => { state.names = [PRODUCTION_NATIVE_SECRET_NAMES[0]]; }, state => { state.intent = {}; }]) {
    const { state, dependencies } = fixture(); setup(state);
    await assert.rejects(bootstrapProductionInvoker("prepare", dependencies), /fresh bootstrap/);
    assert.ok(!state.calls.includes("create")); assert.ok(!state.calls.some(call => call.startsWith("set:")));
  }
  const { state, dependencies } = fixture(); await bootstrapProductionInvoker("prepare", dependencies);
  state.transfers.delete(PRODUCTION_NATIVE_SECRET_NAMES[0]);
  await assert.rejects(bootstrapProductionInvoker("resume", dependencies), /write intent/);
});
test("resume requires the exact sole active key and rejects incomplete or different recovery data", async () => {
  for (const mutate of [state => { state.keys.push({}); }, state => { state.keys[0].Status = "Inactive"; },
    state => { state.keys[0].AccessKeyId = "different"; }, state => { state.credentials.STORY_VIDEO_GRANT_SECRET = "short"; }]) {
    const { state, dependencies } = fixture(); await bootstrapProductionInvoker("prepare", dependencies); mutate(state);
    await assert.rejects(bootstrapProductionInvoker("resume", dependencies));
    assert.equal(state.calls.filter(value => value === "create").length, 1);
  }
});
test("raw personal AWS CLI still cannot print or mutate Production service keys", () => {
  for (const operation of ["create-access-key", "delete-access-key", "list-access-keys", "update-access-key"])
    assert.throws(() => validatePersonalArguments(["iam", operation, "--user-name", PRODUCTION_INVOKER]));
});
