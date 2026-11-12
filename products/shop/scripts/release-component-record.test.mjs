import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { componentHistory, historySource as source } from './release-component-history.fixtures.mjs';
import { protectedConfig } from './protected-config.mjs';
import { publishComponentRecord } from './release-component-record.mjs';

function fixture(target, component) {
    const f = componentHistory(target), runId = component === 'native' ? 10 : 20;
    const record = f.componentRecords.find(r => r.payload.component === component);
    f.componentRecords.splice(f.componentRecords.indexOf(record), 1);
    const job = f.jobs[runId].jobs.find(j => j.id === record.payload.jobId);
    const step = component === 'native' ? target === 'preview' ? 'Verify candidate and execute only the selected guarded Development operation' :
        'Verify evidence and perform only the selected runtime operation' : target === 'preview' ? 'Deploy storefront' : 'Stage, verify and promote storefront';
    job.steps = job.steps.filter(s => s.name === step);
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig('githubRepositoryId'),
        GITHUB_REPOSITORY_OWNER_ID: protectedConfig('githubOwnerId'), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
        GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: source, GITHUB_RUN_ID: String(runId), GITHUB_JOB: job.name,
        GITHUB_WORKFLOW_REF: `bentbrain/bent-mono/${f.runs[runId].path}@refs/heads/main`,
        SHOP_RELEASE_COMPONENT: component, SHOP_RELEASE_TARGET: target, NATIVE_OPERATION: target === 'preview' ? 'release' : 'promote' };
    const posts = [];
    const post = async (path, body) => {
        posts.push({ path, body });
        if (path === 'deployments') {
            assert.equal(body.auto_merge, false); assert.deepEqual(body.required_contexts, []);
            const created = { ...body, id: record.id, sha: body.ref, creator: record.creator, created_at: '2026-01-01T00:01:00Z' };
            f.componentRecords.push(created); f.statuses[created.id] = [];
            return structuredClone(created);
        }
        assert.equal(path, `deployments/${record.id}/statuses`); assert.equal(body.auto_inactive, false);
        f.statuses[record.id] = [{ creator: record.creator, id: record.id * 10, state: body.state, environment: f.environment, log_url: job.html_url,
            deployment_url: `https://api.github.com/repos/bentbrain/bent-mono/deployments/${record.id}`, created_at: '2026-01-01T00:01:00Z' }];
        return f.statuses[record.id][0];
    };
    return { f, job, env, post, posts, now: () => Date.parse('2026-01-01T00:01:00Z') };
}
for (const target of ['preview', 'production']) for (const component of ['native', 'web']) {
    test(`${target}/${component}: publish and read back one verified writer record`, async () => {
        const { f, env, post, posts, now } = fixture(target, component);
        const result = await publishComponentRecord({ env, api: f.api, post, now });
        assert.equal(result.component, component); assert.equal(posts.length, 2);
        assert.equal(posts[0].body.transient_environment, target === 'preview');
        assert.equal(posts[0].body.production_environment, target === 'production');
        await assert.rejects(publishComponentRecord({ env, api: f.api, post, now }), /inspect rather than retry/);
        assert.equal(posts.length, 2);
    });
    for (const problem of ['record-creator', 'status-creator', 'late-record', 'late-status', 'different-id']) {
        test(`${target}/${component}: ${problem} stops uncertain publication without a retry`, async () => {
            const { f, env, post, posts, now } = fixture(target, component);
            const write = async (path, body) => {
                const result = await post(path, body);
                if (path !== 'deployments') {
                    const record = f.componentRecords.at(-1), status = f.statuses[record.id][0];
                    if (problem === 'record-creator') record.creator = { id: 1, login: 'manual', type: 'User' };
                    if (problem === 'status-creator') status.creator = { id: 1, login: 'manual', type: 'User' };
                    if (problem === 'late-record') record.created_at = '2026-01-02T00:00:00Z';
                    if (problem === 'late-status') status.created_at = '2026-01-02T00:00:00Z';
                    if (problem === 'different-id') { record.id++; f.statuses[record.id] = [{ ...status, deployment_url: `https://api.github.com/repos/bentbrain/bent-mono/deployments/${record.id}` }]; }
                }
                return result;
            };
            await assert.rejects(publishComponentRecord({ env, api: f.api, post: write, now }), /inspect rather than retry/);
            assert.equal(posts.length, 2);
        });
    }
    for (const problem of ['local', 'rerun', 'wrong-source', 'wrong-workflow', 'wrong-job', 'failed-step', 'missing-step', 'wrong-owner', 'wrong-run']) {
        test(`${target}/${component}: ${problem} refuses before metadata writes`, async () => {
            const { f, env, job } = fixture(target, component);
            if (problem === 'local') env.GITHUB_ACTIONS = 'false';
            if (problem === 'rerun') env.GITHUB_RUN_ATTEMPT = '2';
            if (problem === 'wrong-source') env.GITHUB_SHA = 'b'.repeat(40);
            if (problem === 'wrong-workflow') env.GITHUB_WORKFLOW_REF += 'x';
            if (problem === 'wrong-job') env.GITHUB_JOB = 'check';
            if (problem === 'failed-step') job.steps[0].conclusion = 'failure';
            if (problem === 'missing-step') job.steps = [];
            if (problem === 'wrong-owner') f.runs[env.GITHUB_RUN_ID].repository.owner.id++;
            if (problem === 'wrong-run') f.runs[env.GITHUB_RUN_ID].id++;
            await assert.rejects(publishComponentRecord({ env, api: f.api, post: () => assert.fail('No write') }));
        });
    }
    test(`${target}/${component}: canonical writer publishes only after its runtime command`, async () => {
        const { env, job } = fixture(target, component);
        const name = env.GITHUB_WORKFLOW_REF.split('/.github/workflows/')[1].split('@')[0];
        const text = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
        const section = text.split(`\n  ${job.name}:\n`)[1].split(/\n  [a-z0-9-]+:\n/)[0];
        assert.ok(section.indexOf('name: Record verified component release') > section.indexOf(`name: ${job.steps[0].name}`));
        assert.ok(section.includes('deployments: write'));
        assert.ok(section.includes(`SHOP_RELEASE_COMPONENT: ${component}`) && section.includes(`SHOP_RELEASE_TARGET: ${target}`));
        assert.ok(!section.includes('if: always()\n        env:\n          SHOP_RELEASE_COMPONENT'));
        if (target === 'preview') {
            const condition = section.split('name: Record verified component release\n')[1].split('\n')[0];
            assert.ok(condition.includes("github.ref == 'refs/heads/main'"));
            assert.ok(condition.includes('github.run_attempt == 1'));
        }
    });
}
