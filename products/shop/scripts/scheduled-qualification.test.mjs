import { componentHistory } from './release-component-history.fixtures.mjs';
import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledQualificationPlan, dispatchScheduledQualification } from './scheduled-qualification.mjs';
const source = 'a'.repeat(40), id = '11111111-1111-4111-8111-111111111111';
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'schedule', GITHUB_SHA: source, GITHUB_RUN_ID: '500',
    GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-qualification-schedule.yml@refs/heads/main' };
function fixture({ deployed = source, active = false, previous } = {}) {
    const history = componentHistory();
    for (const run of Object.values(history.runs)) {
        run.head_sha = deployed; run.display_title = run.display_title.replace(source, deployed);
    }
    for (const deployment of history.deployments) deployment.sha = deployed;
    for (const inventory of Object.values(history.jobs)) for (const job of inventory.jobs) job.head_sha = deployed;
    const run = history.runs[10];
    const api = async (path) => {
        if (path === 'branches/main')
            return { commit: { sha: source } };
        if (path.startsWith('deployments') || /^actions\/runs\/(10|20)(?:\/|$)/.test(path))
            return history.api(path);
        if (path.includes('actions/runs?status='))
            return { total_count: active ? 1 : 0, workflow_runs: active ? [run] : [] };
        return { total_count: previous ? 1 : 0, workflow_runs: previous ? [previous] : [] };
    };
    return { env, api, id };
}
test('weekly qualification never deploys and requires the same inactive personal Development pair on main', async () => {
    const input = fixture(), plan = await scheduledQualificationPlan(input), posts = [];
    assert.equal(plan.operation, 'qualify-all');
    assert.equal(plan.native.runId, 10);
    await dispatchScheduledQualification({ ...input, intent: plan, preserved: structuredClone(plan), post: async (body) => posts.push(body) });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].inputs.operation, 'qualify-all');
    assert.equal(posts[0].inputs.verify_release, 'native-10');
    assert.equal(posts[0].inputs.scheduled_qualification, true);
    assert.equal((await scheduledQualificationPlan(fixture({ deployed: 'b'.repeat(40) }))).dispatch, false);
    assert.equal((await scheduledQualificationPlan(fixture({ active: true }))).dispatch, false);
});
test('reruns, altered intents, failed qualifications and uncertain dispatches cannot silently retry', async () => {
    const input = fixture(), intent = await scheduledQualificationPlan(input);
    await assert.rejects(scheduledQualificationPlan({ ...input, env: { ...env, GITHUB_RUN_ATTEMPT: '2' } }));
    await assert.rejects(dispatchScheduledQualification({ ...input, intent, preserved: { ...intent, source: 'b'.repeat(40) }, post: () => assert.fail() }));
    let posts = 0;
    await assert.rejects(dispatchScheduledQualification({ ...input, intent, preserved: intent, post: async () => { posts++; throw Error('uncertain'); } }));
    assert.equal(posts, 1);
    const previous = { id: 110, path: '.github/workflows/native-development.yml', display_title: 'Native development · qualify-all · full · native-10 ·', status: 'completed', conclusion: 'failure', run_attempt: 1 };
    assert.equal((await scheduledQualificationPlan(fixture({ previous }))).dispatch, false);
    previous.conclusion = 'success';
    previous.updated_at = new Date().toISOString();
    assert.equal((await scheduledQualificationPlan(fixture({ previous }))).dispatch, false);
    previous.display_title = previous.display_title.replace('qualify-all', 'qualify-components');
    assert.equal((await scheduledQualificationPlan(fixture({ previous }))).dispatch, true, 'recent narrow qualification cannot replace the scheduled full suite');
});
test('weekly qualification waits for the automatic camera smoke too', async () => {
    const input = fixture(), api = input.api;
    input.api = path => path.includes('actions/runs?status=') ? { total_count: 1, workflow_runs: [{ path: '.github/workflows/preview-smoke.yml' }] } : api(path);
    assert.equal((await scheduledQualificationPlan(input)).dispatch, false);
});
