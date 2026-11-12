import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHistory, historySource as source } from './release-component-history.fixtures.mjs';
import { componentBaselines, componentReleasePlan } from './release-components.mjs';
import { advanceCoordinator, coordinatedRunTitle, createCoordinator } from './release-coordinator.mjs';
import { scheduledQualificationPlan } from './scheduled-qualification.mjs';
import { protectedConfig } from './protected-config.mjs';

for (const target of ['preview', 'production']) for (const component of ['native', 'web']) {
    for (const problem of ['missing-publisher', 'skipped-publisher', 'failed-publisher', 'unfinished-publisher', 'duplicate-publisher',
        'missing-runtime', 'failed-runtime', 'reversed-steps', 'overlapping-steps', 'invalid-step-time', 'record-before-publisher',
        'record-after-publisher', 'status-after-publisher', 'status-before-record', 'record-user', 'status-user', 'other-bot', 'unknown-creator']) {
        test(`${target}/${component}: ${problem} cannot admit default coordinator or qualification callers`, async () => {
            const f = componentHistory(target), record = f.componentRecords.find(r => r.payload.component === component);
            const writer = f.jobs[record.payload.runId].jobs.find(j => j.id === record.payload.jobId);
            const publisher = writer.steps?.find(s => s.name === 'Record verified component release'), runtime = writer.steps?.[0];
            if (problem === 'missing-publisher') writer.steps = [];
            if (problem === 'skipped-publisher' || problem === 'failed-publisher') { if (publisher) publisher.conclusion = problem === 'skipped-publisher' ? 'skipped' : 'failure'; }
            if (problem === 'unfinished-publisher' && publisher) { publisher.status = 'in_progress'; publisher.conclusion = null; publisher.completed_at = null; }
            if (problem === 'duplicate-publisher' && publisher) writer.steps.push({ ...publisher });
            if (problem === 'missing-runtime') writer.steps = writer.steps?.filter(s => s === publisher);
            if (problem === 'failed-runtime' && runtime) runtime.conclusion = 'failure';
            if (problem === 'reversed-steps' && runtime) runtime.number = 3;
            if (problem === 'overlapping-steps' && runtime) runtime.completed_at = '2026-01-01T00:02:00Z';
            if (problem === 'invalid-step-time' && publisher) publisher.completed_at = 'invalid';
            if (problem === 'record-before-publisher') record.created_at = '2025-12-31T00:00:00Z';
            if (problem === 'record-after-publisher') record.created_at = '2026-06-01T00:00:00Z';
            if (problem === 'status-after-publisher') f.statuses[record.id][0].created_at = '2026-06-01T00:00:00Z';
            if (problem === 'status-before-record') f.statuses[record.id][0].created_at = '2025-12-31T00:00:00Z';
            if (problem === 'record-user') record.creator = { id: 1, login: 'manual', type: 'User' };
            if (problem === 'status-user') f.statuses[record.id][0].creator = { id: 1, login: 'manual', type: 'User' };
            if (problem === 'other-bot') record.creator = { id: 1, login: 'github-actions[bot]', type: 'Bot' };
            if (problem === 'unknown-creator') delete record.creator;
            const baselines = await componentBaselines({ api: f.api, target });
            assert.equal(baselines[component], null);
            const changes = () => undefined;
            const journal = createCoordinator({ source, target, mode: 'auto', selection: componentReleasePlan({ source, target, baselines: { native: null, web: null }, changes }) });
            for (const [i, stage] of journal.stages.entries()) {
                stage.status = 'complete'; stage.runId = i === 0 ? 10 : 20;
                f.runs[stage.runId].display_title = coordinatedRunTitle(journal, i);
            }
            await assert.rejects(advanceCoordinator(journal, { api: f.api, changes, save: () => assert.fail('No journal mutation'), preflight: () => assert.fail('No dispatch') }), /baseline changed/);
            if (target === 'preview' && component === 'native') {
                assert.throws(() => componentReleasePlan({ source, target: 'qualification', baselines, changes }), /exact source/);
                const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig('githubRepositoryId'),
                    GITHUB_REPOSITORY_OWNER_ID: protectedConfig('githubOwnerId'), GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'schedule',
                    GITHUB_SHA: source, GITHUB_RUN_ID: '40', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-qualification-schedule.yml@refs/heads/main' };
                const plan = await scheduledQualificationPlan({ env, api: path => path === 'branches/main' ? { commit: { sha: source } } : f.api(path) });
                assert.equal(plan.dispatch, false);
            }
        });
    }
}
