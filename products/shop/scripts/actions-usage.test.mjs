import { protectedConfig } from "./protected-config.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionsBudget, collectActionsUsage, jobMinutes, releaseMinutes, reviewReleaseBudget, usageReport } from './actions-usage.mjs';
const now = new Date('2026-09-22T01:00:00Z');
const run = (id, extra = {}) => ({ id, created_at: '2026-09-21T00:00:00Z', updated_at: '2026-09-21T01:00:00Z', run_attempt: 1,
    status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml', repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) }, ...extra });
const job = (id, runId, extra = {}) => ({ id, run_id: runId, runner_id: 1, labels: ['ubuntu-latest'], started_at: '2026-09-21T00:00:00Z', completed_at: '2026-09-21T00:01:01Z', ...extra });
const options = { month: '2026-09', now };
test('minutes sum runner time with per-job rounding, all attempts and no queue/skipped/self-hosted charges', () => {
    const jobs = [job(1, 1), job(2, 1, { run_attempt: 2 }), job(3, 1, { runner_id: 0 }), job(4, 1, { conclusion: 'skipped' }),
        job(5, 1, { labels: ['self-hosted', 'Linux'] }), job(6, 2), job(1, 1)];
    const report = usageReport([run(1, { conclusion: 'failure' }), run(2)], jobs, options);
    assert.equal(report.minutes, 6);
    assert.equal(report.failedRunMinutes, 4);
    assert.equal(report.lastSevenDaysMinutes, 6);
    assert.equal(report.workflows[0].jobs, 3);
    assert.equal(report.projectedMonthMinutes, 9);
    assert.throws(() => jobMinutes(job(1, 1, { completed_at: 'bad' })), /timestamps/);
    assert.throws(() => usageReport([run(1, { head_repository: {} })], jobs, options), /foreign/);
});
test('active execution is a lower-bound estimate and unsupported runner prices are explicit', () => {
    const report = usageReport([run(1)], [job(1, 1, { started_at: '2026-09-22T00:59:30Z', completed_at: null, labels: ['windows-latest'] })], options);
    assert.equal(report.minutes, 1);
    assert.equal(report.runningJobs, 1);
    assert.deepEqual(report.unsupportedRunners, ['windows-latest']);
});
test('collection includes reruns and refreshes discovery while reusing completed job records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'actions-usage-'));
    const calls = [];
    let attempt = 1;
    const api = async (path) => {
        calls.push(path);
        if (path.startsWith('actions/runs?'))
            return { total_count: path.includes('created=2026-09-21') ? 1 : 0,
                workflow_runs: path.includes('created=2026-09-21') ? [run(1, { run_attempt: attempt })] : [] };
        assert.match(path, /filter=all/);
        return { total_count: attempt, jobs: Array.from({ length: attempt }, (_, i) => job(i + 1, 1)) };
    };
    try {
        assert.equal((await collectActionsUsage(api, { ...options, cacheDirectory: directory })).minutes, 2);
        calls.length = 0;
        assert.equal((await collectActionsUsage(api, { ...options, cacheDirectory: directory })).minutes, 2);
        assert.equal(calls.filter(path => path.includes('/jobs?')).length, 0);
        attempt = 2;
        assert.equal((await collectActionsUsage(api, { ...options, cacheDirectory: directory })).minutes, 4);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('large or truncated inventories cannot become a misleading zero-cost report', async () => {
    await assert.rejects(collectActionsUsage(async () => ({ total_count: 1001, workflow_runs: [] }), { ...options, cacheDirectory: null }), /Incomplete/);
    await assert.rejects(collectActionsUsage(async () => ({ total_count: 1, workflow_runs: [] }), { ...options, cacheDirectory: null }), /Truncated/);
    await assert.rejects(collectActionsUsage(() => assert.fail(), { month: '2026-13', now }), /month/);
});
test('new batches above the monthly target require a recorded reason; no-op plans cost nothing', () => {
    const usage = { ...usageReport([], [], options), minutes: 2490, lastSevenDaysMinutes: 600 };
    const stages = [{ workflow: 'native-development.yml', inputs: { operation: 'release' } }, { workflow: 'deploy.yml' }];
    assert.equal(releaseMinutes(stages), 40);
    assert.equal(reviewReleaseBudget(usage, stages).allowed, false);
    const review = reviewReleaseBudget(usage, stages, 'Repair a verified production failure');
    assert.equal(review.allowed, true);
    assert.equal(review.weeklyWarning, true);
    assert.ok(review.overrideReason);
    assert.equal(reviewReleaseBudget({ ...usage, minutes: 3000 }, []).allowed, true);
    assert.equal(actionsBudget.monthlyMinutes, 2500);
    assert.throws(() => reviewReleaseBudget(usage, stages, 'yes'), /specific reason/);
    assert.equal(releaseMinutes([{ workflow: 'native-development.yml', inputs: { operation: 'qualify-all' } }]), 30);
});
test('collection reads subsequent run and job pages instead of undercounting busy days', async () => {
    const calls = [];
    const api = async (path) => {
        calls.push(path);
        if (path.startsWith('actions/runs?')) {
            if (!path.includes('created=2026-09-21'))
                return { total_count: 0, workflow_runs: [] };
            return { total_count: 101, workflow_runs: path.endsWith('page=1')
                    ? Array.from({ length: 100 }, (_, i) => run(i + 1, { conclusion: 'skipped' })) : [run(101)] };
        }
        assert.match(path, /runs\/101\/jobs/);
        return { total_count: 101, jobs: path.endsWith('page=1')
                ? Array.from({ length: 100 }, (_, i) => job(i + 1, 101)) : [job(101, 101)] };
    };
    const report = await collectActionsUsage(api, { ...options, cacheDirectory: null });
    assert.equal(report.runs, 101);
    assert.equal(report.minutes, 202);
    assert.equal(calls.filter(path => path.endsWith('page=2')).length, 2);
});
