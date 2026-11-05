import { sealReleaseEvidence, openReleaseEvidence } from "./release-evidence.mjs";
import { protectedConfig } from "./protected-config.mjs";
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual as equal } from 'node:util';
import { componentBaselines } from './release-components.mjs';
import { githubApi, output, summary } from './github-actions.mjs';
const check = (value, reason) => {
    if (!value)
        throw Error(`Scheduled qualification stopped: ${reason}`);
};
function context(env) {
    check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'bentbrain/bent-mono' && env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") &&
        env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_RUN_ATTEMPT === '1' &&
        ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') &&
        /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && env.GITHUB_WORKFLOW_REF === 'bentbrain/bent-mono/.github/workflows/native-qualification-schedule.yml@refs/heads/main', 'first-attempt personal main scheduler');
}
export async function scheduledQualificationPlan({ env, api, now = Date.now(), id = randomUUID() }) {
    context(env);
    const source = (await api('branches/main')).commit?.sha;
    if (source !== env.GITHUB_SHA)
        return { dispatch: false, reason: 'Main advanced; no stale qualification.' };
    const baselines = await componentBaselines({ api, target: 'preview' }), native = baselines.native;
    if (native?.source !== source)
        return { dispatch: false, reason: 'Development does not match main; no deployment will be started.' };
    for (const status of ['in_progress', 'queued', 'waiting', 'pending']) {
        const active = await api(`actions/runs?status=${status}&per_page=100`);
        check(Array.isArray(active.workflow_runs) && active.total_count <= 100, 'bounded active run inventory');
        if (active.workflow_runs.some(run => ['.github/workflows/native-development.yml', '.github/workflows/deploy.yml', '.github/workflows/preview-smoke.yml'].includes(run.path)))
            return { dispatch: false, reason: 'A Development release or qualification is active.' };
    }
    const runs = await api(`actions/workflows/native-development.yml/runs?head_sha=${source}&event=workflow_dispatch&per_page=100`);
    check(Array.isArray(runs.workflow_runs) && runs.total_count <= 100, 'bounded source qualification history');
    const previous = runs.workflow_runs.filter(run => run.path === '.github/workflows/native-development.yml' &&
        new RegExp(`^Native development · (?:qualify-all|qualify-components|cleanup-qualification) · full · native-${native.runId} ·`).test(run.display_title ?? ''))
        .sort((a, b) => b.id - a.id)[0];
    if (previous && (previous.status !== 'completed' || previous.conclusion !== 'success' || previous.run_attempt !== 1))
        return { dispatch: false, reason: 'The previous qualification needs inspection before another scheduled run.' };
    if (previous?.display_title?.startsWith('Native development · qualify-all ·') && Number.isFinite(Date.parse(previous.updated_at)) && now - Date.parse(previous.updated_at) < 6 * 24 * 60 * 60 * 1000)
        return { dispatch: false, reason: 'This pair was qualified within the last six days.' };
    return { schemaVersion: 1, dispatch: true, source, schedulerRunId: Number(env.GITHUB_RUN_ID), native,
        coordinationId: `release-${id}-0`, operation: 'qualify-all' };
}
export async function dispatchScheduledQualification({ env, intent, api, preserved, post }) {
    context(env);
    check(equal(intent, preserved), 'exact acknowledged immutable intent artifact');
    const current = await scheduledQualificationPlan({ env, api, id: intent.coordinationId?.slice(8, -2) });
    check(equal(current, intent), 'source, deployed pair or activity changed after intent');
    check(/^release-[a-f0-9-]{36}-0$/.test(intent.coordinationId), 'bounded dispatch correlation');
    // One POST. An uncertain acknowledgement is a failed scheduler run, never a
    // retry. The immutable artifact retains the correlation for inspection.
    await post({ ref: 'main', inputs: { operation: 'qualify-all', scheduled_qualification: true, verify_release: `native-${intent.native.runId}`,
            expected_source: intent.source, coordination_id: intent.coordinationId } });
}
if (import.meta.main) {
    const env = process.env;
    context(env);
    check(env.RUNNER_TEMP?.startsWith('/') && env.GH_TOKEN, 'private runner and explicit GitHub token');
    const api = githubApi({ token: env.GH_TOKEN, repository: 'bentbrain/bent-mono' }), path = join(env.RUNNER_TEMP, 'scheduled-qualification-intent.json');
    if (process.argv.includes('--dispatch')) {
        const intent = openReleaseEvidence(await readFile(path, 'utf8'),{sourceCommit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,filename:'scheduled-qualification-intent.json'});
        check(/^[1-9][0-9]*$/.test(env.INTENT_ARTIFACT_ID ?? ''), 'acknowledged intent upload');
        const artifact = await api(`actions/artifacts/${env.INTENT_ARTIFACT_ID}`), name = `scheduled-qualification-intent-${env.GITHUB_RUN_ID}`;
        check(artifact.name === name && artifact.expired === false && artifact.workflow_run?.id === Number(env.GITHUB_RUN_ID), 'original immutable intent artifact');
        const directory = await mkdtemp(join(env.RUNNER_TEMP, 'qualification-intent-readback-'));
        let preserved;
        try {
            execFileSync('gh', ['run', 'download', env.GITHUB_RUN_ID, '--repo', 'bentbrain/bent-mono', '--name', name, '--dir', directory], { env: { ...env, GH_TOKEN: env.GH_TOKEN }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
            preserved = openReleaseEvidence(await readFile(join(directory, 'scheduled-qualification-intent.json'), 'utf8'),{sourceCommit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,filename:'scheduled-qualification-intent.json'});
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
        await dispatchScheduledQualification({ env, intent, preserved, api, post: async (body) => {
                const response = await fetch('https://api.github.com/repos/bentbrain/bent-mono/actions/workflows/native-development.yml/dispatches', {
                    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body)
                });
                check(response.status === 204, 'dispatch acknowledgement uncertain; inspect the saved correlation, never rerun');
            } });
        summary('Dispatched one full qualification of the existing Development pair. No application deployment was requested.');
    }
    else {
        const plan = await scheduledQualificationPlan({ env, api });
        output('dispatch', plan.dispatch);
        if (plan.dispatch)
            await writeFile(path, sealReleaseEvidence(plan,{sourceCommit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,filename:'scheduled-qualification-intent.json'}), { flag: 'wx', mode: 0o600 });
        summary(plan.dispatch ? 'Existing Development pair is eligible for full qualification.' : plan.reason);
    }
}
