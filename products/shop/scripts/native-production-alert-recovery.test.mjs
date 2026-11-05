import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support/production-foundation-fixture.mjs";
import { FAILED_ALERT_RUN as FAILED, INTERRUPTED_RECOVERY, inspectAlertRecoveryState, verifyUntaintOnly, inspectAlertRecoveryPlan, verifyOriginalAlertRun, executeAlertRecovery, verifyInterruptedRecovery, repairAlertStateMarker } from "./native-production-alert-recovery.mjs";
function state(tainted = true) {
    const resources = new Map();
    for (const item of fixture(true).resource_changes) {
        const [type, tail] = item.address.split("."), name = tail.split("[")[0];
        const key = `${type}.${name}`;
        const resource = resources.get(key) ?? { type, name, mode: "managed", provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [] };
        const instance = { attributes: structuredClone(item.change.after) };
        if (tail.includes("["))
            instance.index_key = JSON.parse(tail.slice(tail.indexOf("[") + 1, -1));
        if (item.address === FAILED.address) {
            Object.assign(instance.attributes, { id: FAILED.subscription, arn: null, pending_confirmation: null, owner_id: null,
                confirmation_was_authenticated: null, endpoint_auto_confirms: false });
            if (tainted)
                instance.status = "tainted";
        }
        resource.instances.push(instance);
        resources.set(key, resource);
    }
    return { version: 4, terraform_version: "1.12.2", lineage: FAILED.lineage, serial: tainted ? 3 : 4, outputs: {}, resources: [...resources.values()] };
}
test("recovery requires the exact original subscription and only its tainted state", () => {
    assert.equal(inspectAlertRecoveryState(state(), "owner@example.com", true).instances, 19);
    assert.equal(inspectAlertRecoveryState(state(false), "owner@example.com", false).subscriptionTainted, false);
    const subscription = value => value.resources.find(item => item.type === "aws_sns_topic_subscription").instances[0];
    for (const mutate of [
        value => { value.serial = 4; }, value => { value.lineage = "other"; }, value => { value.resources.pop(); },
        value => { value.resources[0].instances[0].status = "tainted"; }, value => { subscription(value).status = undefined; },
        value => { subscription(value).attributes.id = "other"; }, value => { subscription(value).attributes.endpoint = "other@example.com"; },
        value => { subscription(value).attributes.protocol = "sms"; }, value => { subscription(value).deposed = "previous"; },
        value => { value.outputs = { leaked: {} }; }, value => { value.resources[0].provider = "other"; },
    ]) {
        const altered = state();
        mutate(altered);
        assert.throws(() => inspectAlertRecoveryState(altered, "owner@example.com", true));
    }
});
test("untaint may change only the single status marker and state serial", () => {
    assert.doesNotThrow(() => verifyUntaintOnly(state(), state(false)));
    for (const mutate of [value => { value.serial++; }, value => { value.lineage = "other"; },
        value => { value.resources[0].instances[0].attributes = {}; }, value => { value.resources.pop(); }]) {
        const after = state(false);
        mutate(after);
        assert.throws(() => verifyUntaintOnly(state(), after));
    }
});
test("Terraform may reorder unchanged condition-check records during untaint", () => {
    const before = state(), after = state(false);
    before.check_results = [{ object_kind: "resource", config_addr: "aws_sns_topic_subscription.email", status: "pass" },
        { object_kind: "var", config_addr: "var.alert_email", status: "pass" }];
    after.check_results = structuredClone(before.check_results).reverse();
    assert.doesNotThrow(() => verifyUntaintOnly(before, after));
    after.check_results[0].status = "fail";
    assert.throws(() => verifyUntaintOnly(before, after));
});
test("continuation reads the repaired state without repeating untaint", async () => {
    const calls = [], current = state(false);
    const result = await repairAlertStateMarker(async (args) => { calls.push(args); return JSON.stringify(current); }, current, true);
    assert.deepEqual(calls, [["state", "pull"]]);
    assert.deepEqual(result.state, current);
    await assert.rejects(repairAlertStateMarker(async () => JSON.stringify(state()), current, true));
    const firstCalls = [];
    await repairAlertStateMarker(async (args) => { firstCalls.push(args); return JSON.stringify(current); }, state(), false);
    assert.deepEqual(firstCalls, [["untaint", "-no-color", "-lock-timeout=0s", FAILED.address], ["state", "pull"]]);
});
function recoveryPlan() {
    const plan = fixture(true);
    for (const item of plan.resource_changes) {
        item.change.actions = ["no-op"];
        item.change.before = structuredClone(item.change.after);
    }
    const subscription = plan.resource_changes.find(item => item.address === FAILED.address);
    const before = { ...subscription.change.before, id: FAILED.subscription, arn: null, owner_id: null, pending_confirmation: null, confirmation_was_authenticated: null };
    const after = { ...before, arn: FAILED.subscription, owner_id: protectedConfig("awsAccountId"), pending_confirmation: false, confirmation_was_authenticated: false };
    subscription.change.before = structuredClone(after);
    subscription.change.after = structuredClone(after);
    plan.resource_drift = [{ address: FAILED.address, mode: "managed", provider_name: subscription.provider_name, change: { actions: ["update"], before, after } }];
    return plan;
}
test("recovery plan permits computed subscription readback and absolutely no resource mutation", () => {
    assert.equal(inspectAlertRecoveryPlan(recoveryPlan(), "owner@example.com").resourcesUnchanged, 19);
    for (const mutate of [
        value => { value.resource_changes[0].change.actions = ["update"]; }, value => { value.resource_changes[0].change.actions = ["delete", "create"]; },
        value => { value.resource_changes[0].change.importing = {}; }, value => { value.resource_changes[0].change.after.bucket = "other"; },
        value => { value.resource_changes.pop(); }, value => { value.complete = false; }, value => { value.deferred_changes = [{}]; },
        value => { value.resource_drift[0].change.after.pending_confirmation = true; },
        value => { value.resource_drift[0].change.after.endpoint = "other@example.com"; },
        value => { value.resource_drift[0].change.after.delivery_policy = "{}"; }, value => { value.resource_drift.push(value.resource_drift[0]); },
    ]) {
        const altered = recoveryPlan();
        mutate(altered);
        assert.throws(() => inspectAlertRecoveryPlan(altered, "owner@example.com"));
    }
});
function providerReadbackPlan() {
    const plan = recoveryPlan(), subscription = plan.resource_drift[0];
    for (const key of ["delivery_policy", "filter_policy", "filter_policy_scope", "redrive_policy", "replay_policy", "subscription_role_arn"]) {
        subscription.change.before[key] = null;
        subscription.change.after[key] = "";
    }
    const item = plan.resource_changes.find(item => item.address === FAILED.address);
    item.change.before = structuredClone(subscription.change.after);
    item.change.after = structuredClone(subscription.change.after);
    for (const item of plan.resource_changes.filter(item => item.address.startsWith("aws_cloudwatch_metric_alarm.") || item.address === "aws_sns_topic.alerts[0]")) {
        const before = { ...item.change.before, tags: null }, after = { ...item.change.after, tags: {} };
        if (item.address.startsWith("aws_cloudwatch_metric_alarm.")) {
            before.insufficient_data_actions = null;
            after.insufficient_data_actions = [];
        }
        item.change.before = structuredClone(after);
        item.change.after = structuredClone(after);
        plan.resource_drift.push({ address: item.address, mode: "managed", provider_name: item.provider_name, change: { actions: ["update"], before, after } });
    }
    return plan;
}
test("provider readback may fill only the observed empty alert defaults without resource changes", () => {
    assert.equal(inspectAlertRecoveryPlan(providerReadbackPlan(), "owner@example.com").resourcesUnchanged, 19);
    for (const mutate of [
        value => { value.resource_drift[0].change.after.filter_policy = "{}"; },
        value => { value.resource_drift[0].change.after.filter_policy_scope = "MessageBody"; },
        value => { value.resource_drift[0].change.before.delivery_policy = "previous"; },
        value => { value.resource_drift[1].change.after.tags = { Extra: "unexpected" }; },
        value => { value.resource_drift[1].change.after.insufficient_data_actions = ["other-topic"]; },
        value => { value.resource_drift[1].change.after.threshold = 100; },
        value => { value.resource_drift.push(value.resource_drift[1]); },
        value => { value.resource_changes[0].change.actions = ["update"]; },
    ]) {
        const value = providerReadbackPlan();
        mutate(value);
        assert.throws(() => inspectAlertRecoveryPlan(value, "owner@example.com"));
    }
});
const originalRun = () => ({ status: "completed", conclusion: "failure", run_attempt: 1, event: "workflow_dispatch", head_sha: FAILED.sourceCommit,
    head_branch: "main", path: ".github/workflows/native-production-foundation.yml", repository: { id: Number(protectedConfig("githubRepositoryId")) }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) } });
const originalJournal = () => ({ sha: FAILED.sourceCommit, environment: "Production", task: "native-foundation", payload: {
        runId: String(FAILED.runId), planHash: FAILED.planHash, sourceHash: FAILED.sourceHash, operation: "enable-alerts"
    } });
test("recovery is tied to the original failed first-attempt run and its acknowledged journal", async () => {
    const read = async (path) => path.startsWith("/actions") ? originalRun() : originalJournal();
    await verifyOriginalAlertRun(read);
    for (const mutate of [value => { value.run_attempt = 2; }, value => { value.conclusion = "success"; }, value => { value.head_sha = "other"; }]) {
        await assert.rejects(verifyOriginalAlertRun(async (path) => { const value = await read(path); if (path.startsWith("/actions"))
            mutate(value); return value; }));
    }
    await assert.rejects(verifyOriginalAlertRun(async (path) => { const value = await read(path); if (value.payload)
        value.payload.planHash = "other"; return value; }));
});
test("continuation verifies the exact interrupted run and immutable original backup", async () => {
    const read = async (path) => path.startsWith("/actions") ? { ...originalRun(), head_sha: INTERRUPTED_RECOVERY.sourceCommit }
        : { sha: INTERRUPTED_RECOVERY.sourceCommit, environment: "Production", task: "native-alert-recovery", payload: {
                failedRun: FAILED.runId, sourceHash: FAILED.sourceHash, backup: INTERRUPTED_RECOVERY.backup
            } };
    await verifyInterruptedRecovery(read);
    await assert.rejects(verifyInterruptedRecovery(async (path) => { const value = structuredClone(await read(path)); if (value.payload)
        value.payload.backup.version = "other"; return value; }));
    await assert.rejects(verifyInterruptedRecovery(async (path) => { const value = await read(path); if (value.run_attempt)
        value.run_attempt = 2; return value; }));
});
test("changed or already repaired state stops recovery before any writes, untaint or apply", async () => {
    const calls = [];
    await assert.rejects(executeAlertRecovery({ env: { NATIVE_OPERATION: "recover-alerts" }, source: FAILED.sourceHash,
        read: async (path) => path.startsWith("/actions") ? originalRun() : originalJournal(),
        run: async (args) => { calls.push(args); return JSON.stringify(state(false)); },
        save: async () => { throw new Error("must not write"); }, journal: async () => { throw new Error("must not journal"); } }), /snapshot/);
    assert.deepEqual(calls, [["state", "pull"]]);
});
