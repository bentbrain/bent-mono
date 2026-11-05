import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { inspectFoundationPlan, assertFoundationContext, FOUNDATION_RESOURCES, ALERT_RESOURCES, ALARMS, ALERT_ARN, releaseBucketPolicy } from "./native-production-foundation-contract.mjs";
import { foundationAWS, verifyAlertSubscription } from "./native-production-foundation.mjs";
import { PRODUCTION_NAME as NAME } from "./native-production-permissions.mjs";
import { fixture } from "./test-support/production-foundation-fixture.mjs";
const inspect = (value, alerts = false) => inspectFoundationPlan(value, { operation: alerts ? "enable-alerts" : "provision", alertEmail: "owner@example.com" });
test("foundation stages create only private release storage, bounded failure infrastructure and email alarms", () => {
    assert.deepEqual(inspect(fixture()).creates, FOUNDATION_RESOURCES);
    assert.deepEqual(inspect(fixture(true), true).creates, ALERT_RESOURCES);
    assert.equal(inspect(fixture(true), true).firstAndAllReadyMonitoringComplete, false);
});
test("foundation review refuses existing-resource takeover, deletion, public storage and other environments", () => {
    for (const change of [
        value => { value.resource_changes.pop(); },
        value => { value.resource_changes[0].change.before = {}; },
        value => { value.resource_changes[0].change.actions = ["update"]; },
        value => { value.resource_changes[0].change.actions = ["delete", "create"]; },
        value => { value.resource_changes[0].change.after.bucket = "development"; },
        value => { value.resource_changes[0].change.after.force_destroy = true; },
        value => { value.resource_changes[1].change.after.block_public_policy = false; },
        value => { value.resource_changes[2].change.after.versioning_configuration[0].status = "Suspended"; },
        value => { value.resource_changes[5].change.after.policy = "{}"; },
        value => { value.resource_changes[6].change.after.sqs_managed_sse_enabled = false; },
        value => { value.resource_changes[6].change.after.redrive_policy = "{}"; },
        value => { value.resource_changes[6].change.after.policy = "{}"; },
        value => { value.resource_drift = [{}]; },
        value => { value.resource_changes[0].change.importing = {}; },
    ]) {
        const altered = fixture();
        change(altered);
        assert.throws(() => inspect(altered));
    }
});
test("alerts cannot change the owner email, enable SMS, weaken alarms or alter the existing foundation", () => {
    const item = (value, name) => value.resource_changes.find(item => item.address === name);
    for (const change of [
        value => { item(value, "aws_sns_topic_subscription.email[0]").change.after.endpoint = "someone@example.com"; },
        value => { item(value, "aws_sns_topic_subscription.email[0]").change.after.protocol = "sms"; },
        value => { item(value, "aws_sns_topic_subscription.email[0]").change.after.endpoint_auto_confirms = true; },
        value => { item(value, "aws_sns_topic.alerts[0]").change.after.policy = "{}"; },
        value => { item(value, ALERT_RESOURCES[2]).change.after.threshold = 1000; },
        value => { item(value, FOUNDATION_RESOURCES[0]).change.actions = ["update"]; },
    ]) {
        const altered = fixture(true);
        change(altered);
        assert.throws(() => inspect(altered, true));
    }
});
test("alert planning accepts only the already-created bucket child settings and null-to-empty tags", () => {
    const plan = fixture(true), parent = plan.resource_changes.find(item => item.address === "aws_s3_bucket.releases");
    const before = { ...parent.change.before, policy: "", versioning: [{ enabled: false, mfa_delete: false }], tags: null };
    const after = { ...before, policy: JSON.stringify(releaseBucketPolicy()), versioning: [{ enabled: true, mfa_delete: false }], tags: {} };
    parent.change.before = structuredClone(after);
    parent.change.after = structuredClone(after);
    plan.resource_drift = [{ address: parent.address, mode: "managed", provider_name: parent.provider_name, change: { actions: ["update"], before, after } }];
    assert.equal(inspect(plan, true).applicationDeployment, false);
    for (const mutate of [value => { value.resource_drift[0].change.after.policy = "{}"; },
        value => { value.resource_drift[0].change.after.tags = { new: "tag" }; },
        value => { value.resource_drift[0].change.after.grant = [{ permissions: ["READ"] }]; },
        value => { value.resource_changes.find(item => item.address === "aws_s3_bucket_policy.releases").change.actions = ["update"]; },
        value => { value.resource_drift.push(value.resource_drift[0]); },
    ]) {
        const altered = structuredClone(plan);
        mutate(altered);
        assert.throws(() => inspect(altered, true));
    }
});
function env() {
    return { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
        GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "12345",
        GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production-foundation.yml@refs/heads/main", NATIVE_OPERATION: "provision",
        AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "ap-southeast-2", AWS_ACCESS_KEY_ID: "fixture-key", AWS_SECRET_ACCESS_KEY: "fixture-secret", AWS_SESSION_TOKEN: "fixture-session",
        AWS_PROFILE: "work", AWS_ENDPOINT_URL: "https://other.invalid", NODE_OPTIONS: "work" };
}
test("Production credentials require a main-only first-attempt workflow and exact separate role/session", async () => {
    assert.doesNotThrow(() => assertFoundationContext(env()));
    for (const patch of [{ GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_REF: "refs/heads/perf/story-video-family-experiments" }, { GITHUB_EVENT_NAME: "push" },
        { GITHUB_REPOSITORY_OWNER_ID: "1" }, { NATIVE_OPERATION: "release" }, { GITHUB_WORKFLOW_REF: "other" }])
        assert.throws(() => assertFoundationContext({ ...env(), ...patch }));
    const calls = [];
    await foundationAWS(env(), async (_cmd, args, options) => {
        calls.push(args);
        assert.equal(options.env.AWS_PROFILE, undefined);
        assert.equal(options.env.AWS_ENDPOINT_URL, undefined);
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.env.AWS_CONFIG_FILE, "/dev/null");
        assert.equal(options.env.AWS_MAX_ATTEMPTS, "1");
        return { stdout: JSON.stringify({ Account: protectedConfig("awsAccountId"), Arn: "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/forever-tee-video-production-ci/native-production-12345" }) };
    });
    assert.equal(calls.length, 1);
    await assert.rejects(foundationAWS(env(), async () => ({ stdout: JSON.stringify({ Account: protectedConfig("awsAccountId"), Arn: "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/forever-tee-video-development-ci/native-12345" }) })));
});
test("pending email confirmation never becomes a verified alert delivery or triggers a publish", async () => {
    let calls = 0;
    const result = await verifyAlertSubscription(async (args) => {
        calls++;
        assert.equal(args[1], "list-subscriptions-by-topic");
        return { Subscriptions: [{ TopicArn: ALERT_ARN, Protocol: "email", Endpoint: "owner@example.com", Owner: protectedConfig("awsAccountId"), SubscriptionArn: "PendingConfirmation" }] };
    }, "owner@example.com", true);
    assert.equal(calls, 1);
    assert.equal(result.emailSubscriptionConfirmed, false);
    assert.equal(result.alertDeliveryVerified, false);
});
test("an allocated subscription ARN is not proof that its owner confirmed email", async () => {
    let calls = 0;
    const result = await verifyAlertSubscription(async (args) => {
        calls++;
        if (args[1] === "list-subscriptions-by-topic")
            return { Subscriptions: [{ TopicArn: ALERT_ARN, Protocol: "email", Endpoint: "owner@example.com", Owner: protectedConfig("awsAccountId"), SubscriptionArn: `${ALERT_ARN}:fixture` }] };
        assert.equal(args[1], "get-subscription-attributes");
        return { Attributes: { PendingConfirmation: "true", TopicArn: ALERT_ARN, Endpoint: "owner@example.com" } };
    }, "owner@example.com", true);
    assert.equal(calls, 2);
    assert.equal(result.emailSubscriptionConfirmed, false);
});
function confirmedAlerts(mutate = () => { }) {
    const calls = [];
    const call = async (args) => {
        calls.push(args[1]);
        if (args[1] === "list-subscriptions-by-topic")
            return { Subscriptions: [{ TopicArn: ALERT_ARN, Protocol: "email", Endpoint: "owner@example.com",
                        Owner: protectedConfig("awsAccountId"), SubscriptionArn: `${ALERT_ARN}:fixture` }] };
        if (args[1] === "get-subscription-attributes")
            return { Attributes: { PendingConfirmation: "false", TopicArn: ALERT_ARN, Endpoint: "owner@example.com" } };
        if (args[1] === "publish")
            return { MessageId: "fixture-message" };
        assert.equal(args[1], "describe-alarms");
        const key = args[3].slice(NAME.length + 1), [Namespace, MetricName, dimensions, Statistic, Threshold] = ALARMS[key];
        const alarm = { AlarmName: args[3], ActionsEnabled: true, AlarmActions: [ALERT_ARN], OKActions: [ALERT_ARN], InsufficientDataActions: [],
            Namespace, MetricName, Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })), Statistic, Threshold, Period: 60,
            EvaluationPeriods: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching" };
        const result = { MetricAlarms: [alarm], CompositeAlarms: [] };
        mutate(result);
        return result;
    };
    return { call, calls };
}
test("confirmed email requires all live alarm settings before publishing and never proves receipt", async () => {
    const fixture = confirmedAlerts();
    const result = await verifyAlertSubscription(fixture.call, "owner@example.com", true);
    assert.equal(fixture.calls.filter(value => value === "describe-alarms").length, 7);
    assert.equal(fixture.calls.at(-1), "publish");
    assert.equal(result.deliveryCheckPublished, true);
    assert.equal(result.alertDeliveryVerified, false);
    for (const mutate of [
        value => { value.MetricAlarms[0].OKActions = ["arn:aws:sns:ap-southeast-2:" + protectedConfig("awsAccountId") + ":other"]; },
        value => { value.MetricAlarms[0].InsufficientDataActions = [ALERT_ARN]; },
        value => { value.MetricAlarms[0].Metrics = [{ Expression: "1" }]; },
        value => { value.MetricAlarms[0].ExtendedStatistic = "p99"; },
        value => { value.MetricAlarms[0].Unit = "Seconds"; },
        value => { value.MetricAlarms[0].ThresholdMetricId = "e1"; },
        value => { value.MetricAlarms[0].Dimensions.push(value.MetricAlarms[0].Dimensions[0]); },
        value => { value.MetricAlarms[0].DatapointsToAlarm = 2; },
        value => { value.MetricAlarms[0].ActionsEnabled = false; },
        value => { value.NextToken = "more"; },
        value => { value.CompositeAlarms = [{}]; },
    ]) {
        const altered = confirmedAlerts(mutate);
        await assert.rejects(verifyAlertSubscription(altered.call, "owner@example.com", true));
        assert.ok(!altered.calls.includes("publish"));
    }
});
