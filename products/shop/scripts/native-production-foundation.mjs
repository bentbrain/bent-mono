import { protectedConfig } from "./protected-config.mjs";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual as equal } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFoundationContext, inspectFoundationPlan, ALERT_ARN, ALARMS } from "./native-production-foundation-contract.mjs";
import { PRODUCTION_BUCKET as BUCKET, PRODUCTION_NAME as NAME, STATE_BUCKET, STATE_KMS, productionStateStatements } from "./native-production-permissions.mjs";
import { terraformFailureSummary } from "./native-ci-terraform.mjs";
import { executeAlertRecovery } from "./native-production-alert-recovery.mjs";
const execute = promisify(execFile), sha = value => createHash("sha256").update(value).digest("hex");
const MODULE = fileURLToPath(new URL("../infra/story-video-production/", import.meta.url));
const check = (value, reason) => { if (!value)
    throw new Error(`Production foundation stopped: ${reason}`); };
export async function foundationAWS(env, run = execute) {
    assertFoundationContext(env);
    check(env.AWS_REGION === "ap-southeast-2" && env.AWS_DEFAULT_REGION === "ap-southeast-2" &&
        [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN].every(value => typeof value === "string" && value.length > 0), "explicit temporary Sydney credentials.");
    const child = { PATH: "/usr/local/bin:/usr/bin:/bin", AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN, AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "ap-southeast-2", AWS_CONFIG_FILE: "/dev/null",
        AWS_SHARED_CREDENTIALS_FILE: "/dev/null", BOTO_CONFIG: "/dev/null", AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
        AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" };
    const call = async (args) => {
        try {
            const output = await run("aws", [...args, "--region", "ap-southeast-2", "--output", "json", "--no-cli-pager"], { env: child, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
            return output.stdout.trim() ? JSON.parse(output.stdout) : {};
        }
        catch (error) {
            const code = typeof error.stderr === "string" ? /\(([A-Za-z0-9.]+)\) when calling the [A-Za-z0-9]+ operation/.exec(error.stderr)?.[1] : undefined;
            throw Object.assign(new Error("Scoped Production AWS request failed; no private output logged."), { code });
        }
    };
    const identity = await call(["sts", "get-caller-identity"]);
    check(identity.Account === protectedConfig("awsAccountId") && identity.Arn === "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/" + (NAME) + "-ci/native-production-" + (env.GITHUB_RUN_ID), "exact Production CI session, never Development or personal SSO.");
    return { call, child };
}
export async function verifyFoundationStorage(call) {
    const args = ["--bucket", STATE_BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId")];
    check((await call(["s3api", "get-bucket-versioning", ...args])).Status === "Enabled", "versioned state.");
    const rules = (await call(["s3api", "get-bucket-encryption", ...args])).ServerSideEncryptionConfiguration?.Rules;
    check(rules?.length === 1 && rules[0].BucketKeyEnabled === false && rules[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "aws:kms" &&
        rules[0].ApplyServerSideEncryptionByDefault.KMSMasterKeyID === STATE_KMS, "exact KMS object encryption.");
    const access = (await call(["s3api", "get-public-access-block", ...args])).PublicAccessBlockConfiguration;
    check(["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every(key => access?.[key] === true), "private state.");
    const policy = JSON.parse((await call(["s3api", "get-bucket-policy", ...args])).Policy);
    for (const statement of productionStateStatements())
        check(equal(policy.Statement.find(item => item.Sid === statement.Sid), statement), "Production isolation and retention.");
    const capacity = (await call(["lambda", "get-account-settings"])).AccountLimit;
    check(Number.isSafeInteger(capacity?.ConcurrentExecutions) && Number.isSafeInteger(capacity.UnreservedConcurrentExecutions) && capacity.UnreservedConcurrentExecutions >= 110, "at least ten prospective Production slots plus the required 100 unreserved slots.");
    return { stateStorageVerified: true, capacity: { account: capacity.ConcurrentExecutions, unreserved: capacity.UnreservedConcurrentExecutions }, productionCapacityReserved: false };
}
async function requireAbsent(call, args, codes) {
    try {
        await call(args);
    }
    catch (error) {
        if ((Array.isArray(codes) ? codes : [codes]).includes(error.code))
            return;
        throw new Error("Production collision check failed; no apply attempted.");
    }
    throw new Error("Production foundation resource already exists; automatic adoption is forbidden.");
}
export async function verifyAlertSubscription(call, email, publish = false) {
    check(typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "private owner email required.");
    const result = await call(["sns", "list-subscriptions-by-topic", "--topic-arn", ALERT_ARN]);
    check(!result.NextToken && result.Subscriptions?.length === 1, "exact single alert subscription.");
    const item = result.Subscriptions[0];
    check(item.TopicArn === ALERT_ARN && item.Protocol === "email" && item.Endpoint === email && item.Owner === protectedConfig("awsAccountId"), "owner email subscription identity.");
    const confirmed = typeof item.SubscriptionArn === "string" && item.SubscriptionArn.startsWith(`${ALERT_ARN}:`);
    if (!confirmed)
        return { emailSubscriptionConfirmed: false, alertDeliveryVerified: false, smsEnabled: false };
    const attributes = await call(["sns", "get-subscription-attributes", "--subscription-arn", item.SubscriptionArn]);
    check(attributes.Attributes?.TopicArn === ALERT_ARN && attributes.Attributes.Endpoint === email, "live subscription identity.");
    if (attributes.Attributes.PendingConfirmation === "true")
        return { emailSubscriptionConfirmed: false, alertDeliveryVerified: false, smsEnabled: false };
    check(attributes.Attributes.PendingConfirmation === "false", "confirmed live subscription.");
    for (const key of Object.keys(ALARMS)) {
        const alarms = await call(["cloudwatch", "describe-alarms", "--alarm-names", `${NAME}-${key}`]);
        const alarm = alarms.MetricAlarms?.[0], [namespace, metric, dimensions, statistic, threshold] = ALARMS[key];
        check(!alarms.NextToken && !alarms.CompositeAlarms?.length && alarms.MetricAlarms?.length === 1 &&
            alarm.AlarmName === `${NAME}-${key}` && alarm.ActionsEnabled === true && equal(alarm.AlarmActions, [ALERT_ARN]) &&
            equal(alarm.OKActions, [ALERT_ARN]) && !alarm.InsufficientDataActions?.length && !alarm.Metrics?.length && !alarm.ExtendedStatistic && !alarm.Unit &&
            !alarm.ThresholdMetricId && (alarm.DatapointsToAlarm === undefined || alarm.DatapointsToAlarm === 1) &&
            alarm.Namespace === namespace && alarm.MetricName === metric && alarm.Statistic === statistic && alarm.Threshold === threshold && alarm.Period === 60 &&
            alarm.EvaluationPeriods === 1 && alarm.ComparisonOperator === "GreaterThanOrEqualToThreshold" && alarm.TreatMissingData === "notBreaching" &&
            Array.isArray(alarm.Dimensions) && alarm.Dimensions.length === Object.keys(dimensions).length &&
            equal(Object.fromEntries(alarm.Dimensions.map(item => [item.Name, item.Value])), dimensions), "live scoped runtime alarm.");
    }
    if (publish)
        await call(["sns", "publish", "--topic-arn", ALERT_ARN, "--subject", "Forever Tee Production video alert delivery check",
            "--message", "Production video alert subscription confirmed. This is a delivery check only; native Production rendering has not been enabled. Please confirm receipt in the deployment task."]);
    return { emailSubscriptionConfirmed: true, runtimeAlarmsVerified: 7, deliveryCheckPublished: publish, alertDeliveryVerified: false,
        firstAndAllReadyMonitoringComplete: false, smsEnabled: false };
}
async function githubDeployment(env, body, suffix = "") {
    check(typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0, "Actions deployment journal token.");
    const response = await fetch(`https://api.github.com/repos/bentbrain/bent-mono/deployments${suffix}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" }, body: JSON.stringify(body),
    });
    check(response.ok, "durable GitHub deployment journal acknowledgement; inspect before retrying.");
    return response.json();
}
export function foundationEvidenceSaver(directory, runId, call) {
    return async (name, body) => {
        check(/^[a-z][a-z0-9.-]+$/.test(name) && !name.includes(".."), "fixed evidence filename.");
        // Terraform owns the original plan path. Preserve separate bytes without
        // overwriting it; repeated evidence writes must still fail exclusively.
        const path = join(directory, `evidence-${name}`);
        await writeFile(path, body, { flag: "wx", mode: 0o600 });
        const key = `source/foundation/native-${runId}/${name}`;
        const result = await call(["s3api", "put-object", "--bucket", BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId"), "--key", key,
            "--body", path, "--if-none-match", "*", "--server-side-encryption", "AES256"]);
        check(result.VersionId && result.ETag, "immutable private evidence acknowledgement.");
        return { key, version: result.VersionId, sha256: sha(body) };
    };
}
export async function runFoundation(env = process.env) {
    assertFoundationContext(env);
    check(process.platform === "linux" && process.arch === "x64" && env.RUNNER_TEMP?.startsWith("/"), "cloud-only x86 Actions runner.");
    const { call, child } = await foundationAWS(env);
    console.info(JSON.stringify(await verifyFoundationStorage(call)));
    if (env.NATIVE_OPERATION === "verify-alerts")
        return verifyAlertSubscription(call, env.NATIVE_ALERT_EMAIL, true);
    const alerts = ["enable-alerts", "recover-alerts", "finish-alert-recovery"].includes(env.NATIVE_OPERATION);
    process.umask(0o077);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "production-foundation-"));
    const files = [".terraform.lock.hcl", "alerts.tf", "main.tf", "versions.tf"];
    check(equal((await readdir(MODULE)).sort(), files), "fixed Production module files.");
    const sourceHash = async () => {
        const entries = [];
        for (const file of files)
            entries.push([file, sha(await readFile(join(MODULE, file)))]);
        return sha(JSON.stringify(entries));
    };
    const source = await sourceHash();
    const response = await fetch("https://releases.hashicorp.com/terraform/1.12.2/terraform_1.12.2_linux_amd64.zip", { redirect: "error", signal: AbortSignal.timeout(30000) });
    check(response.ok, "pinned Terraform download.");
    const bytes = Buffer.from(await response.arrayBuffer());
    check(sha(bytes) === protectedConfig("resource_9519c9b3fa59"), "pinned Terraform checksum.");
    const archive = join(directory, "terraform.zip");
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
    await execute("/usr/bin/unzip", ["-q", archive, "-d", directory]);
    const tfEnv = { ...child, HOME: directory, TF_DATA_DIR: join(directory, "providers"), TF_CLI_CONFIG_FILE: "/dev/null", TF_INPUT: "false",
        TF_IN_AUTOMATION: "true", TF_WORKSPACE: "default", CHECKPOINT_DISABLE: "1", TF_VAR_enable_alerts: String(alerts), TF_VAR_alert_email: alerts ? env.NATIVE_ALERT_EMAIL ?? "" : "" };
    const run = async (args) => {
        try {
            return (await execute(join(directory, "terraform"), args, { cwd: MODULE, env: tfEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300000 })).stdout;
        }
        catch (error) {
            console.error(JSON.stringify({ terraformOperation: args[0], ...terraformFailureSummary(error) }));
            throw new Error("Production Terraform failed; private output was not logged. Inspect the current run/state before recovery.");
        }
    };
    await run(["init", "-input=false", "-lockfile=readonly", "-no-color"]);
    await run(["validate", "-no-color"]);
    const save = foundationEvidenceSaver(directory, env.GITHUB_RUN_ID, call);
    if (["recover-alerts", "finish-alert-recovery"].includes(env.NATIVE_OPERATION))
        return executeAlertRecovery({ env, call, run, save, directory, source, sourceHash,
            verifyAlerts: publish => verifyAlertSubscription(call, env.NATIVE_ALERT_EMAIL, publish), journal: (body, suffix) => githubDeployment(env, body, suffix),
            read: async (path) => {
                check(["/actions/runs/" + protectedConfig("resource_db5e486e228b"), "/deployments/" + protectedConfig("resource_0baf6953b414"), "/actions/runs/" + protectedConfig("resource_4a5fb45867e9"), "/deployments/" + protectedConfig("resource_83fd601e2da0")].includes(path), "fixed original recovery evidence paths.");
                const response = await fetch(`https://api.github.com/repos/bentbrain/bent-mono${path}`, { redirect: "error", signal: AbortSignal.timeout(30000),
                    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
                check(response.ok, "original recovery evidence read failed.");
                return response.json();
            } });
    const planPath = join(directory, "foundation.tfplan");
    await run(["plan", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", `-out=${planPath}`]);
    const plan = JSON.parse(await run(["show", "-json", planPath]));
    let review;
    try {
        review = inspectFoundationPlan(plan, { operation: env.NATIVE_OPERATION, alertEmail: env.NATIVE_ALERT_EMAIL });
    }
    catch (error) {
        // Retain rejected alert plans privately. The release bucket was created in
        // the preceding stage; never send raw plans/contacts to GitHub artifacts.
        const summarize = item => ({ address: item.address, actions: item.change.actions,
            fields: [...new Set([...Object.keys(item.change.before ?? {}), ...Object.keys(item.change.after ?? {})])]
                .filter(key => !equal(item.change.before?.[key], item.change.after?.[key])) });
        console.error(JSON.stringify({ planRejected: true, drift: plan.resource_drift?.map(summarize), changes: plan.resource_changes?.map(summarize) }));
        if (alerts) {
            const body = JSON.stringify(plan), path = join(directory, "rejected-plan.json"), key = `source/foundation/native-${env.GITHUB_RUN_ID}/rejected-plan.json`;
            await writeFile(path, body, { flag: "wx", mode: 0o600 });
            const saved = await call(["s3api", "put-object", "--bucket", BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId"), "--key", key,
                "--body", path, "--if-none-match", "*", "--server-side-encryption", "AES256"]);
            check(saved.VersionId, "private rejected-plan acknowledgement.");
            console.error(JSON.stringify({ privateRejectedPlan: { key, version: saved.VersionId, sha256: sha(body) } }));
        }
        throw error;
    }
    const planBytes = await readFile(planPath), planHash = sha(planBytes);
    console.info(JSON.stringify({ ...review, planHash, sourceHash: source, runId: env.GITHUB_RUN_ID, sourceCommit: env.GITHUB_SHA }));
    if (env.NATIVE_OPERATION === "plan")
        return { ...review, applied: false };
    if (alerts) {
        await requireAbsent(call, ["sns", "get-topic-attributes", "--topic-arn", ALERT_ARN], "NotFound");
        await save("reviewed.tfplan", planBytes);
    }
    else {
        await requireAbsent(call, ["s3api", "head-bucket", "--bucket", BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId")], "404");
        for (const suffix of ["failures", "failures-dead-letter"])
            await requireAbsent(call, ["sqs", "get-queue-url", "--queue-name", `${NAME}-${suffix}`, "--queue-owner-aws-account-id", protectedConfig("awsAccountId")], ["AWS.SimpleQueueService.NonExistentQueue", "QueueDoesNotExist"]);
        const logs = await call(["logs", "describe-log-groups", "--log-group-name-prefix", `/aws/lambda/${NAME}`]);
        check(!logs.nextToken && logs.logGroups?.length === 0, "Production log groups already exist.");
    }
    // The very first bucket does not exist yet. Acknowledged GitHub deployment
    // intent records its plan/source hashes before apply. Never publish plan bytes
    // or contacts to GitHub artifacts/logs. Later stages preserve private plans first.
    const journal = await githubDeployment(env, { ref: env.GITHUB_SHA, task: "native-foundation", auto_merge: false, required_contexts: [],
        environment: "Production", production_environment: false, description: `Native foundation ${env.NATIVE_OPERATION}, not application cutover`,
        payload: { runId: env.GITHUB_RUN_ID, planHash, sourceHash: source, operation: env.NATIVE_OPERATION } });
    check(Number.isSafeInteger(journal.id), "durable intent ID.");
    await githubDeployment(env, { state: "in_progress", auto_inactive: false, description: "Applying the exact creation-only foundation plan", log_url: `https://github.com/bentbrain/bent-mono/actions/runs/${env.GITHUB_RUN_ID}` }, `/${journal.id}/statuses`);
    check(planHash === sha(await readFile(planPath)) && source === await sourceHash(), "source or saved plan changed.");
    inspectFoundationPlan(JSON.parse(await run(["show", "-json", planPath])), { operation: env.NATIVE_OPERATION, alertEmail: env.NATIVE_ALERT_EMAIL });
    await run(["apply", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", planPath]);
    const state = await run(["state", "pull"]);
    const savedState = await save("after.tfstate", state);
    if (!alerts)
        await save("reviewed.tfplan", planBytes);
    const result = { ...review, applied: true, planHash, sourceHash: source, state: savedState, deploymentJournalId: journal.id,
        ...(alerts ? await verifyAlertSubscription(call, env.NATIVE_ALERT_EMAIL) : {}) };
    const receipt = await save("complete.json", JSON.stringify(result));
    await githubDeployment(env, { state: "success", auto_inactive: false, description: "Foundation complete; application cutover remains gated" }, `/${journal.id}/statuses`);
    return { ...result, receipt };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await runFoundation()));
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
