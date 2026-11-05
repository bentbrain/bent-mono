import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { productionAWS } from "./native-production-ci.mjs";
import { productionCloudflare } from "./native-production-cloudflare.mjs";
import { verifyAlertSubscription } from "./native-production-foundation.mjs";
import { ALERT_ARN } from "./native-production-foundation-contract.mjs";
const BUCKET = "forever-tee-video-production-" + protectedConfig("awsAccountId") + "-ap-southeast-2", PREFIX = "source/monitor/";
const check = (value, reason) => { if (!value)
    throw new Error(`Production readiness monitor stopped: ${reason}`); };
const hash = value => createHash("sha256").update(value).digest("hex");
export const FIRST_READY_LIMIT_MS = 60000, ALL_READY_LIMIT_MS = 120000;
export const PRODUCTION_FAMILY_MONITOR_QUERY = `SELECT jobs.design_revision_id AS revision, MIN(jobs.created_at) AS startedAt, COUNT(*) AS total,
      SUM(CASE WHEN jobs.status='ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN jobs.status='failed' AND jobs.attempt_count>=3 THEN 1 ELSE 0 END) AS exhausted,
      MIN(CASE WHEN jobs.status='ready' THEN jobs.rendered_at END) AS firstAt,
      MAX(CASE WHEN jobs.status='ready' THEN jobs.rendered_at END) AS lastAt
      FROM story_video_jobs AS jobs
      JOIN products ON products.id=jobs.product_id AND products.design_revision_id=jobs.design_revision_id AND products.status='active'
      WHERE jobs.renderer_version='story-video-renderer-v7'
      GROUP BY jobs.design_revision_id HAVING MIN(jobs.created_at)>=? AND (MAX(jobs.created_at)>=? OR SUM(CASE WHEN jobs.status='ready' THEN 1 ELSE 0 END)<4)
      ORDER BY MIN(jobs.created_at) LIMIT 1000`;
export function evaluateProductionFamilies(rows, now, since, pauses = []) {
    check(Array.isArray(rows) && rows.length < 1000 && Number.isSafeInteger(now) && Number.isSafeInteger(since) && since <= now &&
        Array.isArray(pauses) && pauses.length < 100, "bounded complete monitor sample.");
    let previousEnd = since;
    for (const pause of pauses) {
        check(Number.isSafeInteger(pause.startedAt) && Number.isSafeInteger(pause.endedAt) && pause.startedAt >= since &&
            pause.startedAt <= pause.endedAt && pause.endedAt <= now && pause.startedAt >= previousEnd, "valid non-overlapping release pauses.");
        previousEnd = pause.endedAt;
    }
    const elapsed = (startedAt, endedAt) => endedAt - startedAt - pauses.reduce((total, pause) => total + Math.max(0, Math.min(endedAt, pause.endedAt) - Math.max(startedAt, pause.startedAt)), 0);
    const breaches = [], firstTimes = [], allTimes = [];
    for (const row of rows) {
        check(/^[a-f0-9-]{36}$/.test(row.revision) && Number.isSafeInteger(row.startedAt) && row.startedAt >= since && row.startedAt <= now &&
            Number.isSafeInteger(row.total) && row.total > 0 && row.total <= 4 && Number.isSafeInteger(row.ready) && row.ready >= 0 && row.ready <= row.total &&
            Number.isSafeInteger(row.exhausted) && row.exhausted >= 0 && row.exhausted <= row.total &&
            (row.ready === 0 ? row.firstAt === null && row.lastAt === null : Number.isSafeInteger(row.firstAt) && row.firstAt >= row.startedAt &&
                Number.isSafeInteger(row.lastAt) && row.lastAt >= row.firstAt && row.lastAt <= now), "invalid family timing or variant counts.");
        const firstMs = elapsed(row.startedAt, row.firstAt ?? now);
        const allMs = elapsed(row.startedAt, row.ready === 4 ? row.lastAt : now);
        check(firstMs >= 0 && allMs >= firstMs, "non-negative active readiness duration.");
        if (row.ready > 0)
            firstTimes.push(firstMs);
        if (row.ready === 4)
            allTimes.push(allMs);
        const reasons = [];
        if (firstMs > FIRST_READY_LIMIT_MS)
            reasons.push("first-video-over-60s");
        if (allMs > ALL_READY_LIMIT_MS)
            reasons.push("all-four-over-120s");
        if (row.exhausted > 0)
            reasons.push("attempts-exhausted");
        if (reasons.length)
            breaches.push({ revision: row.revision, reasons });
    }
    const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
    return { sampledFamilies: rows.length, completedFamilies: allTimes.length, firstReadyP95Ms: percentile(firstTimes, 0.95),
        allFourReadyP95Ms: percentile(allTimes, 0.95), breaches };
}
export function monitorAlertChanges(previous, report, now) {
    const messages = [];
    if (previous) {
        check(Number.isSafeInteger(previous.checkedAt) && previous.checkedAt <= now && Array.isArray(previous.breaches), "previous monitor receipt.");
        if (now - previous.checkedAt > 900000)
            messages.push("No readiness monitor completed in the previous fifteen minutes. Check Actions scheduling and credentials.");
    }
    const key = value => JSON.stringify([value.revision, value.reasons]);
    const old = new Set((previous?.breaches ?? []).map(key));
    const added = report.breaches.filter(value => !old.has(key(value)));
    if (added.length)
        messages.push(`${added.length} new or changed video-family readiness breaches. First-video threshold 60 seconds, all-four threshold 120 seconds; exhausted attempts also alert.`);
    if (previous?.breaches.length && report.breaches.length === 0)
        messages.push("The previous video-family readiness breaches have cleared from the monitored cohort.");
    if (report.pauseOverdue && !previous?.pauseOverdue)
        messages.push("Production video admissions have been paused for more than thirty minutes.");
    return messages;
}
export function productionMonitoringBaseline(value) {
    check(value?.monitoringVerified === true && Number.isSafeInteger(value.breaches) && value.breaches >= 0 && value.breaches < 1000 &&
        /^[a-f0-9]{64}$/.test(value.breachCohortSha256 ?? "") && value.pauseOverdue === false, "healthy bounded monitoring baseline.");
    return { breaches: value.breaches, breachCohortSha256: value.breachCohortSha256 };
}
export function verifyStableProductionMonitoring(expected, observed) {
    const actual = productionMonitoringBaseline(observed);
    check(expected?.breaches === actual.breaches && expected?.breachCohortSha256 === actual.breachCohortSha256, "pre-existing breach cohort changed.");
    return actual;
}
export async function runProductionMonitor(env) {
    check(["prepare-monitor", "monitor"].includes(env.NATIVE_OPERATION) && process.platform === "linux" && env.RUNNER_TEMP?.startsWith("/"), "explicit cloud monitor operation.");
    const { call } = await productionAWS(env), cf = productionCloudflare(env);
    process.umask(0o077);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "production-monitor-")), bucket = ["--bucket", BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId")];
    let sequence = 0;
    const read = async (name) => {
        const path = join(directory, `read-${sequence++}`);
        let result;
        try {
            result = await call(["s3api", "get-object", ...bucket, "--key", PREFIX + name, path]);
        }
        catch (error) {
            if (["NoSuchKey", "404"].includes(error.code))
                return undefined;
            throw error;
        }
        const bytes = await readFile(path);
        check(bytes.length < 1024 * 1024 && result.VersionId && result.ETag, "versioned bounded monitor receipt.");
        return { value: JSON.parse(bytes), etag: result.ETag, version: result.VersionId };
    };
    const save = async (name, value, etag) => {
        const path = join(directory, `write-${sequence++}`), bytes = Buffer.from(JSON.stringify(value));
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        const result = await call(["s3api", "put-object", ...bucket, "--key", PREFIX + name, "--body", path, "--server-side-encryption", "AES256",
            ...(etag ? ["--if-match", etag] : ["--if-none-match", "*"])]);
        check(result.VersionId, "monitor receipt write was not confirmed.");
        return { key: PREFIX + name, version: result.VersionId, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const activation = await read("activation.json");
    if (env.NATIVE_OPERATION === "prepare-monitor") {
        check(!activation, "monitor already activated; no overwrite or restart of its measurement window.");
        const alerts = await verifyAlertSubscription(call, env.NATIVE_ALERT_EMAIL);
        check(alerts.emailSubscriptionConfirmed && alerts.runtimeAlarmsVerified === 7, "confirmed runtime alert destination.");
        const since = Date.now(), value = { schemaVersion: 1, environment: "production", activatedAt: since, sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
            firstReadyLimitMs: FIRST_READY_LIMIT_MS, allReadyLimitMs: ALL_READY_LIMIT_MS, expectedVariants: 4 };
        const evidence = await save("activation.json", value);
        return { monitorActivated: true, environment: "production", evidence, workerChanged: false, providerCutover: false };
    }
    if (!activation)
        return { monitorActive: false, reason: "not yet activated", providerCutover: false };
    const config = activation.value;
    check(config.schemaVersion === 1 && config.environment === "production" && config.firstReadyLimitMs === FIRST_READY_LIMIT_MS &&
        config.allReadyLimitMs === ALL_READY_LIMIT_MS && config.expectedVariants === 4 && Number.isSafeInteger(config.activatedAt), "fixed monitor configuration.");
    try {
        const now = Date.now(), previous = await read("latest.json");
        const tables = (await cf.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='native_video_release_control'"))[0].results;
        let controls = [], pauses = [];
        if (tables.length) {
            controls = (await cf.query("SELECT paused, release_id, paused_at FROM native_video_release_control WHERE singleton=1"))[0].results;
            check(controls.length === 1 && [0, 1].includes(controls[0].paused), "release-control observation.");
            const rows = (await cf.query(`SELECT prepared.release_id AS releaseId, prepared.created_at AS startedAt,
        (SELECT MIN(ended.created_at) FROM native_video_release_events AS ended
          WHERE ended.release_id=prepared.release_id AND ended.stage IN ('verified','backlog-admission-started','preflight-aborted','release-aborted')) AS endedAt
        FROM native_video_release_events AS prepared
        WHERE prepared.stage='prepared' AND prepared.created_at>=?
        ORDER BY prepared.created_at LIMIT 100`, [config.activatedAt]))[0].results;
            check(rows.length < 100 && rows.filter(row => row.endedAt === null).length === controls[0].paused, "bounded complete release-pause history.");
            pauses = rows.map(row => {
                check(/^native-[1-9][0-9]+$/.test(row.releaseId) && Number.isSafeInteger(row.startedAt) &&
                    (Number.isSafeInteger(row.endedAt) || row.endedAt === null), "release-pause identity and timestamps.");
                if (row.endedAt === null)
                    check(controls[0].paused === 1 && controls[0].release_id === row.releaseId && controls[0].paused_at === row.startedAt, "open pause must be the current durable owner.");
                return { startedAt: row.startedAt, endedAt: row.endedAt ?? now };
            });
        }
        // Include the last day's completed families and every unfinished family
        // since activation. The limit is a fail-closed bound, not silent sampling.
        const rows = (await cf.query(PRODUCTION_FAMILY_MONITOR_QUERY, [config.activatedAt, now - 86400000]))[0].results;
        const report = { ...evaluateProductionFamilies(rows, now, config.activatedAt, pauses), checkedAt: now, runId: env.GITHUB_RUN_ID,
            sourceCommit: env.GITHUB_SHA, excludedReleasePauses: pauses.length };
        report.breachCohortSha256 = hash(JSON.stringify(report.breaches));
        if (tables.length) {
            report.pauseOverdue = controls[0].paused === 1 && now - controls[0].paused_at > 1800000;
        }
        else
            report.pauseOverdue = false;
        const messages = monitorAlertChanges(previous?.value, report, now);
        if (messages.length)
            await call(["sns", "publish", "--topic-arn", ALERT_ARN, "--subject", "Forever Tee Production video readiness alert",
                "--message", `${messages.join("\n")}\nActions run: https://github.com/bentbrain/bent-mono/actions/runs/${env.GITHUB_RUN_ID}`]);
        const evidence = await save("latest.json", report, previous?.etag);
        return { ...report, breaches: report.breaches.length, monitoringVerified: true, alertPublished: messages.length > 0, evidence };
    }
    catch (error) {
        // A failed read is not a healthy sample. GitHub also marks this run failed.
        try {
            await call(["sns", "publish", "--topic-arn", ALERT_ARN, "--subject", "Forever Tee Production video monitor failed",
                "--message", `Readiness monitoring could not complete. Inspect https://github.com/bentbrain/bent-mono/actions/runs/${env.GITHUB_RUN_ID}. No job or admission state was changed.`]);
        }
        catch { /* Actions failure is the fallback if AWS/SNS is also unavailable. */ }
        throw error;
    }
}
