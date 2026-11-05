import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readRegularFile } from './read-regular-file.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validationInputs, matchingValidation } from './validation-inputs.mjs';
// A later deploy failure does not invalidate a finished successful validation
// job. Never reuse failed checks, reruns, partial jobs or PR-authored receipts.
const workflows = { 'deploy.yml': 'validate', 'web-production.yml': 'validate', 'native-development.yml': 'check' };
async function download(api, runId, job, token) {
    const listing = await api(`actions/runs/${runId}/artifacts?per_page=100`), name = `validation-inputs-${runId}-${job}`;
    if (!Array.isArray(listing.artifacts) || listing.total_count > 100)
        return null;
    const matches = listing.artifacts.filter(item => item.name === name && item.expired === false);
    if (matches.length !== 1)
        return null;
    const directory = await mkdtemp(join(tmpdir(), 'validation-inputs-'));
    try {
        execFileSync('gh', ['run', 'download', String(runId), '--repo', 'bentbrain/bent-mono', '--name', name, '--dir', directory], { env: { ...process.env, GH_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
        const path = join(directory, `validation-inputs-${job}.json`);
        return JSON.parse(resolveProtectedTemplate(await readRegularFile(path, { maxBytes: 4096 })));
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
export async function reuseComponentValidation({ api, sha, branch, repository, currentRunId, env = process.env, inputs = validationInputs, readPointer }) {
    if (branch !== 'main' || repository !== 'bentbrain/bent-mono')
        return undefined;
    const current = inputs(sha, { env });
    if (!current)
        return undefined;
    for (const [workflow, job] of Object.entries(workflows)) {
        const result = await api(`actions/workflows/${workflow}/runs?branch=main&event=workflow_dispatch&per_page=20`);
        if (!Array.isArray(result.workflow_runs))
            continue;
        for (const run of result.workflow_runs) {
            if (String(run.id) === String(currentRunId) || run.status !== 'completed' || !['success', 'failure'].includes(run.conclusion) || run.run_attempt !== 1 ||
                run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.path !== `.github/workflows/${workflow}` ||
                run.repository?.id !== Number(protectedConfig("githubRepositoryId")) || run.repository?.owner?.id !== Number(protectedConfig("githubOwnerId")) || run.head_repository?.id !== Number(protectedConfig("githubRepositoryId")))
                continue;
            let before;
            try {
                before = inputs(run.head_sha, { env });
            }
            catch {
                continue;
            }
            if (!matchingValidation(before, current))
                continue;
            const jobs = await api(`actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
            if (jobs.total_count > 100 || !jobs.jobs?.some(item => item.name === job && item.head_sha === run.head_sha && item.conclusion === 'success' &&
                item.steps?.some(step => step.name === 'Check commit without existing CI' && step.conclusion === 'success')))
                continue;
            let record;
            try {
                record = await (readPointer ?? ((id, job) => download(api, id, job, env.GH_TOKEN)))(run.id, job);
            }
            catch {
                continue;
            }
            if (record?.runId === run.id && record.job === job && record.sourceCommit === run.head_sha && matchingValidation(record, before))
                return run.id;
        }
    }
    return undefined;
}
