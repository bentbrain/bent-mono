import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProductionFamilies, monitorAlertChanges, productionMonitoringBaseline, PRODUCTION_FAMILY_MONITOR_QUERY, verifyStableProductionMonitoring } from "./native-production-monitor.mjs";
import { assertProductionContext } from "./native-production-ci.mjs";
const now = 1000000, since = 1;
const family = { revision: "11111111-1111-4111-8111-111111111111", startedAt: 800000, total: 4, ready: 4, exhausted: 0, firstAt: 810000, lastAt: 820000 };
test("readiness monitor measures first and all-four completion separately, including unfinished and missing variants", () => {
    assert.equal(evaluateProductionFamilies([family], now, since).breaches.length, 0);
    const firstSlow = { ...family, firstAt: 870000, lastAt: 900000 };
    assert.deepEqual(evaluateProductionFamilies([firstSlow], now, since).breaches[0].reasons, ["first-video-over-60s"]);
    const allSlow = { ...family, lastAt: 940000 };
    assert.deepEqual(evaluateProductionFamilies([allSlow], now, since).breaches[0].reasons, ["all-four-over-120s"]);
    for (const row of [{ ...family, total: 3, ready: 3 }, { ...family, ready: 1 }, { ...family, ready: 0, firstAt: null, lastAt: null }])
        assert.ok(evaluateProductionFamilies([row], now, since).breaches[0].reasons.includes("all-four-over-120s"));
    assert.ok(evaluateProductionFamilies([{ ...family, ready: 0, exhausted: 4, firstAt: null, lastAt: null }], now, since).breaches[0].reasons.includes("attempts-exhausted"));
    assert.equal(evaluateProductionFamilies([family], now, since).firstReadyP95Ms, 10000);
    assert.equal(evaluateProductionFamilies([family], now, since).allFourReadyP95Ms, 20000);
    assert.equal(evaluateProductionFamilies([], now, since).firstReadyP95Ms, null);
});
test("readiness latency excludes only durable non-overlapping release pauses", () => {
    const paused = [{ startedAt: 850000, endedAt: now }];
    const unfinished = { ...family, ready: 0, firstAt: null, lastAt: null };
    assert.equal(evaluateProductionFamilies([unfinished], now, since, paused).breaches.length, 0);
    const resumed = [{ startedAt: 850000, endedAt: 950000 }];
    const completedAfterResume = { ...family, firstAt: 960000, lastAt: 980000 };
    const report = evaluateProductionFamilies([completedAfterResume], now, since, resumed);
    assert.equal(report.firstReadyP95Ms, 60000);
    assert.equal(report.allFourReadyP95Ms, 80000);
    assert.equal(report.breaches.length, 0);
    for (const pauses of [[{ startedAt: 0, endedAt: 2 }], [{ startedAt: 900000, endedAt: 800000 }],
        [{ startedAt: 800000, endedAt: 900000 }, { startedAt: 850000, endedAt: 950000 }], Array(100).fill({ startedAt: 1, endedAt: 1 })])
        assert.throws(() => evaluateProductionFamilies([family], now, since, pauses));
});
test("missing, truncated or malformed readiness data is never healthy", () => {
    for (const values of [Array(1000).fill(family), [{ ...family, total: 5 }], [{ ...family, firstAt: null }],
        [{ ...family, startedAt: now + 1 }], [{ ...family, ready: 5 }], [{ ...family, lastAt: now + 1 }]])
        assert.throws(() => evaluateProductionFamilies(values, now, since));
});
test("readiness alerts deduplicate unchanged breaches and report recovery, delayed monitors and overdue pauses", () => {
    const breach = { revision: family.revision, reasons: ["all-four-over-120s"] };
    const previous = { checkedAt: now - 300000, breaches: [breach], pauseOverdue: false };
    assert.deepEqual(monitorAlertChanges(previous, { breaches: [breach], pauseOverdue: false }, now), []);
    assert.equal(monitorAlertChanges(undefined, { breaches: [breach] }, now).length, 1);
    assert.equal(monitorAlertChanges(previous, { breaches: [], pauseOverdue: false }, now).length, 1);
    assert.equal(monitorAlertChanges(previous, { breaches: [breach], pauseOverdue: true }, now).length, 1);
    assert.equal(monitorAlertChanges({ ...previous, checkedAt: 1 }, { breaches: [breach] }, now).length, 1);
});
test("release gates fingerprint stable historical breaches without requiring an empty monitor", () => {
    const observed = { monitoringVerified: true, breaches: 27, breachCohortSha256: "a".repeat(64), pauseOverdue: false };
    const baseline = productionMonitoringBaseline(observed);
    assert.deepEqual(baseline, { breaches: 27, breachCohortSha256: "a".repeat(64) });
    assert.deepEqual(verifyStableProductionMonitoring(baseline, observed), baseline);
    assert.throws(() => verifyStableProductionMonitoring(baseline, { ...observed, breaches: 28 }));
    assert.throws(() => verifyStableProductionMonitoring(baseline, { ...observed, breachCohortSha256: "b".repeat(64) }));
    assert.throws(() => productionMonitoringBaseline({ ...observed, pauseOverdue: true }));
});
test("Production operations reject scheduled runs after automatic monitoring is disabled", () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
        GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "1234",
        GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production.yml@refs/heads/main", NATIVE_OPERATION: "monitor" };
    assert.throws(() => assertProductionContext(env));
    assert.doesNotThrow(() => assertProductionContext({ ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }));
    for (const operation of ["prepare-runtime", "prepare-worker", "prepare-monitor", "release", "rollback"])
        assert.throws(() => assertProductionContext({ ...env, NATIVE_OPERATION: operation }));
});
test("readiness monitoring uses the same active current-revision eligibility as reconciliation", () => {
    assert.match(PRODUCTION_FAMILY_MONITOR_QUERY, /JOIN products ON products\.id=jobs\.product_id AND products\.design_revision_id=jobs\.design_revision_id AND products\.status='active'/);
    assert.match(PRODUCTION_FAMILY_MONITOR_QUERY, /WHERE jobs\.renderer_version='story-video-renderer-v7'/);
    assert.match(PRODUCTION_FAMILY_MONITOR_QUERY, /SUM\(CASE WHEN jobs\.status='ready'/);
    assert.doesNotMatch(PRODUCTION_FAMILY_MONITOR_QUERY, /FROM story_video_jobs WHERE/);
});
test("pause history retains historical backlog admission as a terminal stage", async () => {
    const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("./native-production-monitor.mjs", import.meta.url), "utf8"));
    assert.match(source, /ended\.stage IN \('verified','backlog-admission-started','preflight-aborted','release-aborted'\)/);
    assert.match(source, /SELECT MIN\(ended\.created_at\)/);
});
