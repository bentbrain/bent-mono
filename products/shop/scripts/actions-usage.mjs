import { protectedConfig } from "./protected-config.mjs";
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { githubApi } from './github-actions.mjs';
export const actionsBudget = Object.freeze({ monthlyMinutes: 2500, weeklyMinutes: 575 });
const repository = 'bentbrain/bent-mono';
const identity = run => run.repository?.id === Number(protectedConfig("githubRepositoryId")) && run.repository.owner?.id === Number(protectedConfig("githubOwnerId")) && run.head_repository?.id === Number(protectedConfig("githubRepositoryId"));
export function jobMinutes(job, now = Date.now()) {
    if (!job.runner_id || job.conclusion === 'skipped' || !job.started_at)
        return 0;
    const start = Date.parse(job.started_at);
    const end = job.completed_at ? Date.parse(job.completed_at) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        throw Error('Invalid Actions job timestamps.');
    return Math.ceil((end - start) / 60000);
}
export function usageReport(runs, jobs, { month, now = new Date() }) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw Error('Use a UTC month in YYYY-MM format.');
    const selected = new Map();
    for (const run of runs) {
        if (!identity(run))
            throw Error('Actions usage contains foreign repository evidence.');
        if (run.created_at?.startsWith(`${month}-`))
            selected.set(run.id, run);
    }
    const workflows = new Map(), seen = new Set();
    let minutes = 0, lastSevenDaysMinutes = 0, failedRunMinutes = 0, runningJobs = 0;
    const unsupportedRunners = new Set();
    for (const job of jobs) {
        const run = selected.get(job.run_id);
        if (!run || seen.has(job.id))
            continue;
        seen.add(job.id);
        if (job.labels?.includes('self-hosted'))
            continue;
        const used = jobMinutes(job, now.getTime());
        if (!used)
            continue;
        // This repository uses standard Linux runners. Report other labels explicitly;
        // this estimate must never silently imply their billing rate is equivalent.
        if (!job.labels?.some(label => /^ubuntu-(?:latest|\d\d\.\d\d)$/.test(label)))
            unsupportedRunners.add((job.labels ?? []).join(',') || 'unknown');
        const key = run.path?.replace('.github/workflows/', '') ?? 'unknown';
        const row = workflows.get(key) ?? { workflow: key, minutes: 0, jobs: 0 };
        row.minutes += used;
        row.jobs++;
        workflows.set(key, row);
        minutes += used;
        if (Date.parse(job.started_at) >= now.getTime() - 7 * 86400000)
            lastSevenDaysMinutes += used;
        if (['failure', 'cancelled', 'timed_out'].includes(run.conclusion))
            failedRunMinutes += used;
        if (!job.completed_at)
            runningJobs++;
    }
    const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    const elapsedDays = now.toISOString().startsWith(month) ? now.getUTCDate() : days;
    return { schemaVersion: 1, repository, month, measuredAt: now.toISOString(), basis: 'Runs created in this UTC month; elapsed minutes rounded up per hosted job, including rerun attempts. The seven-day subtotal is limited to this month. Active jobs are incomplete; not a GitHub invoice.',
        minutes, lastSevenDaysMinutes, failedRunMinutes, runningJobs, runs: selected.size,
        projectedMonthMinutes: Math.ceil(minutes / elapsedDays * days),
        monthlyTarget: actionsBudget.monthlyMinutes, weeklyTarget: actionsBudget.weeklyMinutes,
        remainingTargetMinutes: Math.max(0, actionsBudget.monthlyMinutes - minutes),
        unsupportedRunners: [...unsupportedRunners],
        workflows: [...workflows.values()].sort((a, b) => b.minutes - a.minutes) };
}
async function mapBounded(items, work) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length)
                return;
            results[index] = await work(items[index]);
        }
    }));
    return results;
}
// Cache only completed inventories keyed by run update and attempt. Refresh run
// discovery every time so new attempts cannot disappear behind a cached total.
export async function collectActionsUsage(api, { month = new Date().toISOString().slice(0, 7), now = new Date(), cacheDirectory = '.data/actions-usage' } = {}) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > now.toISOString().slice(0, 7))
        throw Error('Choose the current or an earlier UTC month.');
    const days = month === now.toISOString().slice(0, 7) ? now.getUTCDate() : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    const lists = await mapBounded(Array.from({ length: days }, (_, day) => `${month}-${String(day + 1).padStart(2, '0')}`), async (date) => {
        const rows = [];
        for (let page = 1; page <= 10; page++) {
            const result = await api(`actions/runs?created=${date}&per_page=100&page=${page}`);
            if (!Array.isArray(result.workflow_runs) || !Number.isSafeInteger(result.total_count) || result.total_count > 1000)
                throw Error('Incomplete daily Actions run inventory.');
            rows.push(...result.workflow_runs);
            if (rows.length >= result.total_count)
                return rows;
            if (!result.workflow_runs.length)
                throw Error('Truncated Actions run inventory.');
        }
        throw Error('Actions run inventory exceeds its bounded window.');
    });
    const runs = [...new Map(lists.flat().map(run => [run.id, run])).values()];
    if (runs.some(run => !identity(run) || !Number.isSafeInteger(run.id) || run.id < 1))
        throw Error('Invalid personal repository run identity.');
    if (cacheDirectory)
        await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const inventories = await mapBounded(runs, async (run) => {
        if (run.conclusion === 'skipped')
            return [];
        const file = cacheDirectory ? join(cacheDirectory, `${run.id}.json`) : null;
        const key = JSON.stringify([run.id, run.run_attempt, run.updated_at]);
        const cached = file ? await readFile(file, 'utf8').then(JSON.parse).catch(() => null) : null;
        if (run.status === 'completed' && cached?.key === key && Array.isArray(cached.jobs))
            return cached.jobs;
        const jobs = [];
        for (let page = 1; page <= 10; page++) {
            const result = await api(`actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`);
            if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count > 1000 || result.jobs.some(job => job.run_id !== run.id))
                throw Error('Incomplete Actions job inventory.');
            jobs.push(...result.jobs);
            if (jobs.length >= result.total_count) {
                if (file && run.status === 'completed') {
                    const temporary = `${file}.${process.pid}.tmp`;
                    await writeFile(temporary, JSON.stringify({ key, jobs }), { mode: 0o600 });
                    await rename(temporary, file);
                }
                return jobs;
            }
            if (!result.jobs.length)
                throw Error('Truncated Actions job inventory.');
        }
        throw Error('Actions job inventory exceeds its bounded window.');
    });
    return usageReport(runs, inventories.flat(), { month, now });
}
// Planning estimates, not limits or benchmark promises. Keep costly full qualification in
// the forecast rather than implying image reuse removes drain or cloud tests.
export function releaseMinutes(stages) {
    return stages.reduce((sum, stage) => {
        const operation = stage.inputs?.operation;
        if (stage.status === 'complete')
            return sum;
        if (stage.workflow === 'native-development.yml')
            return sum + ({ 'qualify-all': 30, 'qualify-components': 20, release: 25, 'build-candidate': 15 }[operation] ?? 15);
        return sum + ({ 'native-production.yml': 20, 'deploy.yml': 15, 'web-production.yml': 15, 'preview-smoke.yml': 5 }[stage.workflow] ?? 20);
    }, 0);
}
export function reviewReleaseBudget(usage, stages, reason) {
    if (usage.repository !== repository || usage.schemaVersion !== 1 || !Number.isFinite(usage.minutes))
        throw Error('Missing personal Actions usage evidence.');
    if (reason !== undefined && (reason.trim().length < 12 || reason.length > 500 || /[\r\n\x00-\x1f]/.test(reason)))
        throw Error('Budget override needs a short, specific reason of 12–500 characters.');
    const estimatedMinutes = releaseMinutes(stages);
    const exceedsTarget = estimatedMinutes > 0 && usage.minutes + estimatedMinutes > actionsBudget.monthlyMinutes;
    return { ...usage, estimatedMinutes, exceedsTarget, weeklyWarning: usage.lastSevenDaysMinutes > actionsBudget.weeklyMinutes,
        allowed: !exceedsTarget || Boolean(reason), ...(reason ? { overrideReason: reason.trim() } : {}),
        guidance: exceedsTarget ? 'Batch nonessential changes. An explicit --budget-reason records why this new batch must exceed the monthly target. Existing journals and recovery can finish.' : 'Batch related changes and qualify the final candidate once.' };
}
if (import.meta.main) {
    try {
        const { values } = parseArgs({ options: { month: { type: 'string' } } });
        const token = execFileSync('gh', ['auth', 'token', '--user', 'bentbrain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        console.log(JSON.stringify(await collectActionsUsage(githubApi({ token, repository }), { month: values.month }), null, 2));
    }
    catch (error) {
        console.error(`Actions usage unavailable: ${error.message}`);
        process.exitCode = 1;
    }
}
