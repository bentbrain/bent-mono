import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { inspectFoundationPlan, FOUNDATION_RESOURCES, ALERT_RESOURCES, ALERT_ARN } from "./native-production-foundation-contract.mjs";
import { PRODUCTION_BUCKET } from "./native-production-permissions.mjs";
const check = (value, reason) => { if (!value)
    throw new Error(`Production alert recovery stopped: ${reason}`); };
const sha = value => createHash("sha256").update(value).digest("hex");
export function normalizeCheckOrder(state) {
    const normalized = structuredClone(state);
    if (Array.isArray(normalized.check_results))
        normalized.check_results.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return normalized;
}
export const FAILED_ALERT_RUN = Object.freeze({ runId: Number(protectedConfig("resource_db5e486e228b")), journalId: Number(protectedConfig("resource_0baf6953b414")),
    sourceCommit: "ecc8edc1955180971418169297c6e2ee3d1f8a91", planHash: protectedConfig("resource_71662e305f5a"),
    sourceHash: protectedConfig("resource_a590a92edc62"),
    stateHash: protectedConfig("resource_653cec798e8e"),
    stateContentHash: protectedConfig("resource_78cce6a70394"),
    lineage: protectedConfig("resource_4a54aa95c731"), serial: 3,
    subscription: (ALERT_ARN) + ":" + protectedConfig("resource_ed269f352a9a"), address: "aws_sns_topic_subscription.email[0]" });
export const INTERRUPTED_RECOVERY = Object.freeze({ runId: Number(protectedConfig("resource_4a5fb45867e9")), journalId: Number(protectedConfig("resource_83fd601e2da0")),
    sourceCommit: protectedConfig("alertVerificationSourceCommit"), stateContentHash: protectedConfig("resource_6072ee167746"),
    backup: { key: "source/foundation/native-" + protectedConfig("resource_4a5fb45867e9") + "/recovery-before.tfstate", version: protectedConfig("alertRecoveryStateBackupVersion"),
        sha256: protectedConfig("resource_7a8b6c63f02e") } });
function instances(state) {
    return state.resources.flatMap(resource => resource.instances.map(instance => ({ resource, instance,
        address: `${resource.type}.${resource.name}${instance.index_key === undefined ? "" : `[${JSON.stringify(instance.index_key)}]`}` })));
}
export function inspectAlertRecoveryState(state, email, tainted) {
    check(state.version === 4 && state.terraform_version === "1.12.2" && state.lineage === FAILED_ALERT_RUN.lineage &&
        Number.isSafeInteger(state.serial) && (tainted ? state.serial === 3 : state.serial >= 4) && Object.keys(state.outputs ?? {}).length === 0, "exact Production state lineage/version/serial.");
    check(Array.isArray(state.resources) && state.resources.every(resource => resource.mode === "managed" &&
        resource.provider === 'provider["registry.terraform.io/hashicorp/aws"]' && Array.isArray(resource.instances)), "managed AWS state only.");
    const items = instances(state);
    check(equal(items.map(item => item.address).sort(), [...FOUNDATION_RESOURCES, ...ALERT_RESOURCES].sort()), "exact nineteen instances.");
    for (const { address, instance } of items)
        check(!instance.deposed &&
            (tainted && address === FAILED_ALERT_RUN.address ? instance.status === "tainted" : !instance.status), "only the recorded subscription may be tainted.");
    const subscription = items.find(item => item.address === FAILED_ALERT_RUN.address).instance.attributes;
    check(subscription.id === FAILED_ALERT_RUN.subscription && subscription.topic_arn === ALERT_ARN && subscription.endpoint === email &&
        subscription.protocol === "email" && subscription.endpoint_auto_confirms === false, "same recorded owner subscription.");
    // Reuse the foundation's complete configuration checks. This projection is
    // validation only; it is never passed to Terraform or treated as a real plan.
    inspectFoundationPlan({ terraform_version: "1.12.2", complete: true, errored: false, output_changes: {},
        resource_changes: items.map(({ address, instance }) => ({ address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
            change: { actions: [FOUNDATION_RESOURCES.includes(address) ? "no-op" : "create"],
                before: FOUNDATION_RESOURCES.includes(address) ? instance.attributes : null, after: instance.attributes } })) }, { operation: "enable-alerts", alertEmail: email });
    return { lineage: state.lineage, serial: state.serial, instances: items.length, subscriptionTainted: tainted };
}
export function verifyUntaintOnly(before, after) {
    check(after.serial === before.serial + 1, "one state revision for untaint.");
    const restored = structuredClone(after);
    restored.serial = before.serial;
    const item = instances(restored).find(item => item.address === FAILED_ALERT_RUN.address);
    check(item && !item.instance.status, "subscription taint cleared.");
    item.instance.status = "tainted";
    check(equal(normalizeCheckOrder(restored), normalizeCheckOrder(before)), "untaint must not change any other state data.");
}
export async function repairAlertStateMarker(run, before, finishing) {
    if (!finishing)
        await run(["untaint", "-no-color", "-lock-timeout=0s", FAILED_ALERT_RUN.address]);
    const bytes = await run(["state", "pull"]), state = JSON.parse(bytes);
    if (!finishing)
        verifyUntaintOnly(before, state);
    else
        check(equal(normalizeCheckOrder(before), normalizeCheckOrder(state)), "state changed while continuing.");
    return { bytes, state };
}
export function inspectAlertRecoveryPlan(plan, email) {
    check(plan.terraform_version === "1.12.2" && plan.complete === true && plan.errored === false && !plan.deferred_changes?.length &&
        Object.keys(plan.output_changes ?? {}).length === 0 && equal(plan.resource_changes?.map(item => item.address).sort(), [...FOUNDATION_RESOURCES, ...ALERT_RESOURCES].sort()), "complete exact recovery plan.");
    for (const item of plan.resource_changes)
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" &&
            !item.previous_address && !item.change.importing && equal(item.change.actions, ["no-op"]) && equal(item.change.before, item.change.after), "all nineteen existing resources must remain unchanged.");
    const subscription = plan.resource_changes.find(item => item.address === FAILED_ALERT_RUN.address).change.after;
    check(subscription.id === FAILED_ALERT_RUN.subscription && subscription.arn === FAILED_ALERT_RUN.subscription &&
        subscription.owner_id === protectedConfig("awsAccountId") && subscription.pending_confirmation === false, "confirmed original subscription readback.");
    const seen = new Set();
    for (const item of plan.resource_drift ?? []) {
        check(!seen.has(item.address) && ALERT_RESOURCES.includes(item.address) && item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" &&
            !item.previous_address && !item.change.importing && equal(item.change.actions, ["update"]) &&
            equal(item.change.after, plan.resource_changes.find(resource => resource.address === item.address)?.change.after), "only unique existing alert observations.");
        seen.add(item.address);
        const restored = structuredClone(item.change.after);
        if (item.address === FAILED_ALERT_RUN.address) {
            for (const [key, expected] of Object.entries({ arn: FAILED_ALERT_RUN.subscription, owner_id: protectedConfig("awsAccountId"), pending_confirmation: false })) {
                check(item.change.before[key] === null && restored[key] === expected, "only known computed subscription identity fields.");
                restored[key] = null;
            }
            check(item.change.before.confirmation_was_authenticated === null && typeof restored.confirmation_was_authenticated === "boolean", "confirmation observation.");
            restored.confirmation_was_authenticated = null;
            for (const key of ["delivery_policy", "filter_policy", "filter_policy_scope", "redrive_policy", "replay_policy", "subscription_role_arn"]) {
                if (equal(restored[key], item.change.before[key]))
                    continue;
                check(item.change.before[key] === null && restored[key] === "", "only observed empty subscription defaults.");
                restored[key] = null;
            }
        }
        else {
            for (const [key, expected] of Object.entries({ tags: {}, ...(item.address.startsWith("aws_cloudwatch_metric_alarm.") ? { insufficient_data_actions: [] } : {}) })) {
                if (equal(restored[key], item.change.before[key]))
                    continue;
                check(item.change.before[key] === null && equal(restored[key], expected), "only observed empty alert defaults.");
                restored[key] = null;
            }
        }
        check(equal(restored, item.change.before), "unreviewed alert change.");
    }
    const projected = structuredClone(plan);
    delete projected.resource_drift;
    for (const item of projected.resource_changes)
        if (ALERT_RESOURCES.includes(item.address)) {
            item.change.actions = ["create"];
            item.change.before = null;
        }
    inspectFoundationPlan(projected, { operation: "enable-alerts", alertEmail: email });
    return { resourcesUnchanged: 19, creates: 0, deletes: 0, subscriptionPreserved: true, applicationDeployment: false };
}
export async function verifyOriginalAlertRun(read) {
    const original = await read(`/actions/runs/${FAILED_ALERT_RUN.runId}`);
    check(original.status === "completed" && original.conclusion === "failure" && original.run_attempt === 1 && original.event === "workflow_dispatch" &&
        original.head_sha === FAILED_ALERT_RUN.sourceCommit && original.head_branch === "main" && original.path === ".github/workflows/native-production-foundation.yml" &&
        original.repository?.id === Number(protectedConfig("githubRepositoryId")) && original.head_repository?.id === Number(protectedConfig("githubRepositoryId")), "original failed first-attempt run.");
    const journal = await read(`/deployments/${FAILED_ALERT_RUN.journalId}`);
    check(journal.sha === FAILED_ALERT_RUN.sourceCommit && journal.environment === "Production" && journal.task === "native-foundation" &&
        equal(journal.payload, { runId: String(FAILED_ALERT_RUN.runId), planHash: FAILED_ALERT_RUN.planHash, sourceHash: FAILED_ALERT_RUN.sourceHash, operation: "enable-alerts" }), "original acknowledged apply intent.");
}
export async function verifyInterruptedRecovery(read) {
    const run = await read(`/actions/runs/${INTERRUPTED_RECOVERY.runId}`);
    check(run.status === "completed" && run.conclusion === "failure" && run.run_attempt === 1 && run.event === "workflow_dispatch" &&
        run.head_sha === INTERRUPTED_RECOVERY.sourceCommit && run.head_branch === "main" && run.path === ".github/workflows/native-production-foundation.yml" &&
        run.repository?.id === Number(protectedConfig("githubRepositoryId")) && run.head_repository?.id === Number(protectedConfig("githubRepositoryId")), "exact interrupted recovery run.");
    const journal = await read(`/deployments/${INTERRUPTED_RECOVERY.journalId}`);
    check(journal.sha === INTERRUPTED_RECOVERY.sourceCommit && journal.environment === "Production" && journal.task === "native-alert-recovery" &&
        equal(journal.payload, { failedRun: FAILED_ALERT_RUN.runId, sourceHash: FAILED_ALERT_RUN.sourceHash, backup: INTERRUPTED_RECOVERY.backup }), "exact interrupted recovery intent and backup.");
}
export async function executeAlertRecovery({ env, call, run, save, directory, source, sourceHash, read, journal, verifyAlerts }) {
    const finishing = env.NATIVE_OPERATION === "finish-alert-recovery";
    check((finishing || env.NATIVE_OPERATION === "recover-alerts") && source === FAILED_ALERT_RUN.sourceHash, "explicit recovery of the unchanged original module.");
    await verifyOriginalAlertRun(read);
    const beforeBytes = await run(["state", "pull"]);
    const before = JSON.parse(beforeBytes);
    check(sha(JSON.stringify(normalizeCheckOrder(before))) === (finishing ? INTERRUPTED_RECOVERY.stateContentHash : protectedConfig("resource_04d83ff740ca")), "exact inspected post-failure snapshot; never replay after state changes.");
    inspectAlertRecoveryState(before, env.NATIVE_ALERT_EMAIL, !finishing);
    if (finishing) {
        await verifyInterruptedRecovery(read);
        const backupPath = join(directory, "interrupted-before.tfstate");
        const received = await call(["s3api", "get-object", "--bucket", PRODUCTION_BUCKET, "--key", INTERRUPTED_RECOVERY.backup.key,
            "--version-id", INTERRUPTED_RECOVERY.backup.version, "--expected-bucket-owner", protectedConfig("awsAccountId"), backupPath]);
        const bytes = await readFile(backupPath);
        check(received.VersionId === INTERRUPTED_RECOVERY.backup.version && sha(bytes) === INTERRUPTED_RECOVERY.backup.sha256, "original recovery backup bytes.");
        const original = JSON.parse(bytes);
        inspectAlertRecoveryState(original, env.NATIVE_ALERT_EMAIL, true);
        verifyUntaintOnly(original, before);
    }
    const key = `source/foundation/native-${FAILED_ALERT_RUN.runId}/reviewed.tfplan`, path = join(directory, "original.tfplan");
    const object = await call(["s3api", "head-object", "--bucket", PRODUCTION_BUCKET, "--key", key, "--expected-bucket-owner", protectedConfig("awsAccountId")]);
    check(object.VersionId && object.ContentLength > 0, "original private saved plan version.");
    const received = await call(["s3api", "get-object", "--bucket", PRODUCTION_BUCKET, "--key", key, "--version-id", object.VersionId,
        "--expected-bucket-owner", protectedConfig("awsAccountId"), path]);
    check(received.VersionId === object.VersionId && sha(await readFile(path)) === FAILED_ALERT_RUN.planHash, "original saved plan bytes.");
    const originalPlan = JSON.parse(await run(["show", "-json", path]));
    inspectFoundationPlan(originalPlan, { operation: "enable-alerts", alertEmail: env.NATIVE_ALERT_EMAIL });
    const subscription = (await call(["sns", "get-subscription-attributes", "--subscription-arn", FAILED_ALERT_RUN.subscription])).Attributes;
    check(subscription?.SubscriptionArn === FAILED_ALERT_RUN.subscription && subscription.TopicArn === ALERT_ARN && subscription.Endpoint === env.NATIVE_ALERT_EMAIL &&
        subscription.Protocol === "email" && subscription.Owner === protectedConfig("awsAccountId") && subscription.PendingConfirmation === "false" &&
        !subscription.FilterPolicy && !subscription.RedrivePolicy && !subscription.SubscriptionRoleArn, "confirmed unchanged live owner subscription.");
    check((await verifyAlerts(false)).runtimeAlarmsVerified === 7, "all live alarms verified before state repair.");
    const backup = await save("recovery-before.tfstate", beforeBytes);
    const intent = await journal({ ref: env.GITHUB_SHA, task: "native-alert-recovery", auto_merge: false, required_contexts: [], environment: "Production", production_environment: false,
        description: "Preserve the verified existing email subscription; no resource replacement", payload: { failedRun: FAILED_ALERT_RUN.runId, sourceHash: source, backup } });
    check(Number.isSafeInteger(intent.id), "durable recovery intent acknowledged.");
    await journal({ state: "in_progress", auto_inactive: false, description: "Repairing only the verified subscription state marker" }, `/${intent.id}/statuses`);
    check(source === await sourceHash() && equal(normalizeCheckOrder(JSON.parse(await run(["state", "pull"]))), normalizeCheckOrder(before)), "source/state changed before repair.");
    const { bytes: untaintedBytes, state: untainted } = await repairAlertStateMarker(run, before, finishing);
    await save("recovery-untainted.tfstate", untaintedBytes);
    inspectAlertRecoveryState(untainted, env.NATIVE_ALERT_EMAIL, false);
    const planPath = join(directory, "recovery.tfplan");
    await run(["plan", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", `-out=${planPath}`]);
    const planBytes = await readFile(planPath);
    await save("recovery.tfplan", planBytes);
    const raw = await run(["show", "-json", planPath]);
    await save("recovery-plan.json", raw);
    let review;
    try {
        review = inspectAlertRecoveryPlan(JSON.parse(raw), env.NATIVE_ALERT_EMAIL);
    }
    catch (error) {
        const plan = JSON.parse(raw);
        console.error(JSON.stringify({ rejectedRecoveryPlan: true, drift: plan.resource_drift?.map(item => ({ address: item.address,
                fields: [...new Set([...Object.keys(item.change.before ?? {}), ...Object.keys(item.change.after ?? {})])].filter(key => !equal(item.change.before?.[key], item.change.after?.[key])) })) }));
        throw error;
    }
    check(source === await sourceHash() && sha(await readFile(planPath)) === sha(planBytes) &&
        equal(normalizeCheckOrder(JSON.parse(await run(["state", "pull"]))), normalizeCheckOrder(untainted)), "recovery plan/source/state changed.");
    // No AWS resource mutations: this saved no-change plan persists readback of
    // the subscription's previously unknown computed attributes.
    await run(["apply", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", planPath]);
    const afterBytes = await run(["state", "pull"]);
    const afterState = JSON.parse(afterBytes);
    const state = inspectAlertRecoveryState(afterState, env.NATIVE_ALERT_EMAIL, false);
    const afterSubscription = instances(afterState).find(item => item.address === FAILED_ALERT_RUN.address).instance.attributes;
    check(afterSubscription.arn === FAILED_ALERT_RUN.subscription && afterSubscription.owner_id === protectedConfig("awsAccountId") &&
        afterSubscription.pending_confirmation === false, "persisted confirmed subscription readback.");
    const after = await save("recovery-after.tfstate", afterBytes);
    const alertStatus = await verifyAlerts(false);
    const receipt = await save("recovery-complete.json", JSON.stringify({ ...review, state, after, alertStatus, failedRun: FAILED_ALERT_RUN.runId, deploymentJournalId: intent.id }));
    await journal({ state: "failure", auto_inactive: false, description: `Original apply failed; existing resources recovered in Actions ${env.GITHUB_RUN_ID}` }, `/${FAILED_ALERT_RUN.journalId}/statuses`);
    if (finishing)
        await journal({ state: "failure", auto_inactive: false, description: `Recovery stopped after untaint; completed in Actions ${env.GITHUB_RUN_ID}` }, `/${INTERRUPTED_RECOVERY.journalId}/statuses`);
    await journal({ state: "success", auto_inactive: false, description: "Existing subscription recovered; human alert receipt is a separate gate" }, `/${intent.id}/statuses`);
    return { ...review, state, ...alertStatus, receipt, deploymentJournalId: intent.id };
}
