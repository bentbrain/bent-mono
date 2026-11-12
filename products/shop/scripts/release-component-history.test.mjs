import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHistory, historySource as source } from './release-component-history.fixtures.mjs';
import { componentBaselines, componentReleasePlan } from './release-components.mjs';
import { advanceCoordinator, coordinatedRunTitle, createCoordinator } from './release-coordinator.mjs';
for (const target of ['preview', 'production']) {
    test(`${target}: actual writer jobs survive shared environment success-to-inactive history`, async () => {
        const f = componentHistory(target);
        assert.deepEqual(await componentBaselines({ api: f.api, target }), {
            native: { source, runId: 10, deploymentId: target === 'preview' ? 101 : 100 },
            web: { source, runId: 20, deploymentId: 201 },
        });
    });
}
test('default discovery completes the auto journal then plans exact-source qualification', async () => {
    const f = componentHistory();
    const changes = () => undefined;
    const selection = componentReleasePlan({ source, target: 'preview', baselines: { native: null, web: null }, changes });
    const journal = createCoordinator({ source, target: 'preview', mode: 'auto', selection });
    for (const [index, stage] of journal.stages.entries()) {
        stage.status = index === 0 ? 'complete' : 'dispatched';
        stage.runId = index === 0 ? 10 : 20;
        f.runs[stage.runId].display_title = coordinatedRunTitle(journal, index);
    }
    const saves = [];
    const api = (path, body) => path === 'branches/main' ? { commit: { sha: source } } : f.api(path, body);
    const outcome = await advanceCoordinator(journal, { api, changes, save: async j => saves.push(structuredClone(j)), preflight: () => assert.fail('No new dispatch') });
    assert.equal(outcome.state, 'complete');
    assert.equal(saves.length, 1);
    const baselines = await componentBaselines({ api, target: 'preview' });
    const plan = componentReleasePlan({ source, target: 'qualification', baselines, changes });
    assert.deepEqual(plan.stages, [{ workflow: 'native-development.yml', inputs: { operation: 'qualify-all', verify_release: 'native-10' } }]);
    assert.throws(() => componentReleasePlan({ source: 'b'.repeat(40), target: 'qualification', baselines, changes }), /exact source/);
});
for (const target of ['preview', 'production']) {
    const discover = f => componentBaselines({ api: f.api, target });
    test(`${target}: latest genuine writer replaces its component and invalidates an older completed journal`, async () => {
        for (const component of ['native', 'web']) {
            const f = componentHistory(target), before = await discover(f);
            f.addRun(30, component); f.inactivate();
            const after = await discover(f);
            assert.equal(after[component].runId, 30);
            assert.equal(after[component === 'native' ? 'web' : 'native'].runId, component === 'native' ? 20 : 10);
            const { verifyComponentBaselines } = await import('./release-components.mjs');
            assert.throws(() => verifyComponentBaselines({ source, selection: { baselines: before }, stages: [
                { status: 'complete', workflow: component === 'native' ? `native-${target === 'preview' ? 'development' : 'production'}.yml` : target === 'preview' ? 'deploy.yml' : 'web-production.yml', inputs: component === 'native' ? { operation: 'release' } : {}, runId: before[component].runId },
            ] }, after), /baseline changed/);
        }
    });
    for (const component of ['native', 'web']) {
        for (const problem of ['failure', 'in_progress', 'cancelled', 'rerun', 'partial', 'writer-failed', 'status-failed', 'status-error', 'status-pending', 'old-success-after-failure']) {
            test(`${target}: later ${component} ${problem} blocks historical fallback`, async () => {
                const f = componentHistory(target); f.addRun(30, component); f.inactivate();
                const run = f.runs[30], writer = f.jobs[30].jobs.find(j => j.name === (component === 'web' ? target === 'preview' ? 'deploy' : 'release' : target === 'preview' ? 'build' : 'verify'));
                if (['failure', 'cancelled'].includes(problem)) run.conclusion = problem;
                if (problem === 'in_progress') { run.status = problem; run.conclusion = null; }
                if (problem === 'rerun') run.run_attempt = 2;
                if (problem === 'partial') {
                    if (target === 'production' && component === 'native') f.jobs[30].total_count++;
                    else f.deployments.splice(f.deployments.findIndex(d => d.id === writer.id), 1);
                }
                if (problem === 'writer-failed') writer.conclusion = 'failure';
                if (problem.startsWith('status-')) f.statuses[writer.id][0].state = problem.slice(7) === 'failed' ? 'failure' : problem.slice(7);
                if (problem === 'old-success-after-failure') f.statuses[writer.id].unshift({ ...f.statuses[writer.id][0], id: writer.id * 10 + 6, state: 'failure' });
                assert.equal((await discover(f))[component], null);
            });
        }
    }
    for (const operation of ['rollback', 'recover-rollback', 'recover-release', 'complete-forward-release', 'release-storefront', 'unknown-operation']) {
        test(`${target}: later ${operation} never admits an older pair`, async () => {
            const f = componentHistory(target); f.addRun(30, 'native', operation); f.inactivate();
            assert.deepEqual(await discover(f), { web: null, native: null });
        });
    }
    for (const operation of ['qualify-all', 'qualify-components', 'cleanup-qualification', 'cleanup-failed-qualification', 'inspect-failed-qualification', 'monitor']) {
        test(`${target}: authenticated ${operation} jobs retain both actual writers`, async () => {
            const f = componentHistory(target); f.addRun(30, 'native', operation); f.inactivate();
            const result = await discover(f);
            assert.equal(result.native.runId, 10); assert.equal(result.web.runId, 20);
        });
    }
    const invalid = {
        'wrong run ID': f => f.runs[20].id = 500,
        'wrong run SHA': f => f.runs[20].head_sha = 'b'.repeat(40),
        'wrong deployment SHA': f => f.deployments.at(-1).sha = 'b'.repeat(40),
        'wrong owner': f => f.runs[20].repository.owner.id = 1,
        'wrong repository': f => f.runs[20].repository.id = 1,
        'wrong head repository': f => f.runs[20].head_repository.id = 1,
        'wrong branch': f => f.runs[20].head_branch = 'other',
        'wrong event': f => f.runs[20].event = 'push',
        'unknown workflow': f => f.runs[20].path = '.github/workflows/unknown.yml',
        'wrong target title': f => f.runs[20].display_title = 'Storefront · production · preview=true · full=false · main',
        'wrong title source': f => f.runs[20].display_title = f.runs[20].display_title.replace(source, 'b'.repeat(40)),
        'wrong native title target': f => f.runs[10].display_title = f.runs[10].display_title.replace('Native ', 'Other '),
        'partial title': f => f.runs[20].display_title = f.runs[20].display_title.split(' · main')[0],
        'wrong title branch': f => f.runs[20].display_title = f.runs[20].display_title.replace('main ·', 'other ·'),
        'unknown correlation': f => f.runs[20].display_title = f.runs[20].display_title.replace('[manual]', '[unknown]'),
        'missing statuses': f => f.statuses[f.deployments.at(-1).id] = [],
        'unknown status': f => f.statuses[f.deployments.at(-1).id][0].state = 'unknown',
        'duplicate status': f => f.statuses[f.deployments.at(-1).id].push(f.statuses[f.deployments.at(-1).id][0]),
        'wrong status environment': f => f.statuses[f.deployments.at(-1).id][0].environment = 'Other',
        'wrong status deployment': f => f.statuses[f.deployments.at(-1).id][0].deployment_url += '1',
        'wrong status job': f => f.statuses[f.deployments.at(-1).id][0].log_url += '1',
        'wrong status repository': f => f.statuses[f.deployments.at(-1).id][0].log_url = f.statuses[f.deployments.at(-1).id][0].log_url.replace('bentbrain', 'other'),
        'run-only status log': f => f.statuses[f.deployments.at(-1).id][0].log_url = `https://github.com/bentbrain/bent-mono/actions/runs/20`,
        'mixed history jobs': f => f.statuses[f.deployments.at(-1).id].at(-1).log_url += '1',
        'invalid status date': f => f.statuses[f.deployments.at(-1).id][0].created_at = 'invalid',
        'backward status time': f => f.statuses[f.deployments.at(-1).id].at(-1).created_at = '2030-01-01T00:00:00Z',
        'wrong job source': f => f.jobs[20].jobs[0].head_sha = 'b'.repeat(40),
        'wrong job run': f => f.jobs[20].jobs[0].run_id = 1,
        'wrong job branch': f => f.jobs[20].jobs[0].head_branch = 'other',
        'wrong job attempt': f => f.jobs[20].jobs[0].run_attempt = 2,
        'wrong job URL': f => f.jobs[20].jobs[0].html_url += '1',
        'unknown job name': f => f.jobs[20].jobs[0].name = 'unknown',
        'duplicate job name': f => f.jobs[20].jobs[0].name = f.jobs[20].jobs[1].name,
        'duplicate job ID': f => f.jobs[20].jobs[0].id = f.jobs[20].jobs[1].id,
        'missing job inventory': f => f.jobs[20].jobs = [],
        'truncated job inventory': f => f.jobs[20].total_count = 101,
        'saturated job inventory': f => { f.jobs[20].jobs = Array(100).fill(f.jobs[20].jobs[0]); f.jobs[20].total_count = 100; },
        'duplicate deployments': f => f.deployments.push(f.deployments[0]),
        'saturated deployment inventory': f => f.deployments.splice(0, f.deployments.length, ...Array(100).fill(f.deployments[0])),
        'wrong environment': f => f.deployments.at(-1).environment = 'Other',
        'saturated statuses': f => f.statuses[f.deployments.at(-1).id] = Array(100).fill(f.statuses[f.deployments.at(-1).id][0]),
    };
    for (const [problem, mutate] of Object.entries(invalid)) {
        test(`${target}: ${problem} fails closed`, async () => {
            const f = componentHistory(target); mutate(f);
            assert.deepEqual(await discover(f), { web: null, native: null });
        });
    }
    test(`${target}: the active component record corroborates a writer after unrelated environment history is removed`, async () => {
        const f = componentHistory(target);
        f.deployments.splice(0, f.deployments.length, ...f.deployments.filter(d => d.id < 200));
        assert.equal((await discover(f)).native.runId, 10);
    });
    test(`${target}: inactive without success and history rewritten after success cannot establish a writer`, async () => {
        for (const mutation of ['no-success', 'later-failure', 'second-success']) {
            const f = componentHistory(target), id = target === 'preview' ? 101 : 100;
            const s = f.statuses[id];
            if (mutation === 'no-success') s.splice(s.findIndex(x => x.state === 'success'), 1);
            if (mutation === 'later-failure') s[0].state = 'failure';
            if (mutation === 'second-success') s.at(-1).state = 'success';
            assert.equal((await discover(f)).native, null);
        }
    });
}
for (const target of ['preview', 'production']) {
    for (const repeated of [false, true]) {
        test(`${target}: ${repeated ? 'repeated' : 'delayed'} inactivity needs an authoritative component record through actual callers`, async () => {
            const f = componentHistory(target), writer = target === 'preview' ? 101 : 100;
            f.componentRecords.splice(0);
            f.statuses[writer][0].created_at = '2026-01-02T00:00:00Z'; f.statuses[writer][0].id = 99990;
            if (repeated) f.statuses[writer].unshift({ ...f.statuses[writer][0], id: 99991, created_at: '2026-01-03T00:00:00Z' });
            const baselines = await componentBaselines({ api: f.api, target });
            assert.deepEqual(baselines, { native: null, web: null });
            const selection = componentReleasePlan({ source, target, baselines: { native: null, web: null }, changes: () => undefined });
            const journal = createCoordinator({ source, target, mode: 'auto', selection });
            for (const [i, stage] of journal.stages.entries()) {
                stage.status = 'complete'; stage.runId = i === 0 ? 10 : 20;
                f.runs[stage.runId].display_title = coordinatedRunTitle(journal, i);
            }
            await assert.rejects(advanceCoordinator(journal, { api: f.api, changes: () => undefined, save: () => assert.fail('No journal mutation'), preflight: () => assert.fail('No dispatch') }), /baseline changed/);
            if (target === 'preview') assert.throws(() => componentReleasePlan({ source, target: 'qualification', baselines, changes: () => undefined }), /exact source/);
        });
    }
    for (const problem of ['missing', 'inactive', 'failed', 'wrong-job', 'wrong-source', 'duplicate', 'unknown-schema', 'nontransient', 'newer-record']) {
        test(`${target}: ${problem} component corroboration blocks the candidate`, async () => {
            const f = componentHistory(target), record = f.componentRecords.find(r => r.payload.component === 'native');
            if (problem === 'missing') f.componentRecords.splice(f.componentRecords.indexOf(record), 1);
            if (problem === 'inactive' || problem === 'failed') f.statuses[record.id][0].state = problem === 'failed' ? 'failure' : 'inactive';
            if (problem === 'wrong-job') record.payload.jobId++;
            if (problem === 'wrong-source') record.payload.source = 'b'.repeat(40);
            if (problem === 'duplicate') f.componentRecords.push({ ...record, id: record.id + 1 });
            if (problem === 'unknown-schema') record.payload.schemaVersion = 2;
            if (problem === 'nontransient') record.transient_environment = target !== 'preview';
            if (problem === 'newer-record') f.componentRecords.push({ ...record, id: record.id + 1, payload: { ...record.payload, runId: 30 } });
            assert.equal((await componentBaselines({ api: f.api, target })).native, null);
        });
    }
}
test('writer job inventories match the canonical workflows and run titles', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const target of ['preview', 'production']) {
        const f = componentHistory(target);
        if (target === 'preview') f.addRun(30, 'smoke');
        for (const run of Object.values(f.runs)) {
            const workflow = await readFile(new URL(`../${run.path}`, import.meta.url), 'utf8');
            const jobSection = workflow.slice(workflow.indexOf('\njobs:\n'));
            const names = [...jobSection.matchAll(/^  ([a-z0-9-]+):$/gm)].map(m => m[1]);
            assert.deepEqual(f.jobs[run.id].jobs.map(j => j.name), names);
            const input = { environment: 'development', web_only_preview: true, force_full: false, operation: target === 'preview' ? 'release' : 'promote', release_mode: 'full' };
            const title = /^run-name: (.+)$/m.exec(workflow)[1].replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => {
                const [key, fallback] = expression.split(' || ');
                return key === 'github.ref_name' ? 'main' : key === 'github.sha' ? source : input[key.replace('inputs.', '')] ?? fallback?.slice(1, -1);
            });
            assert.equal(run.display_title, title);
        }
    }
});
test('an interleaved newer component run prevents admission of an older writer', async () => {
    const f = componentHistory(); f.addRun(30, 'native');
    // The older run writes after the newer run has entered the environment.
    const oldWriter = f.deployments.find(d => d.id === 101);
    f.deployments.splice(f.deployments.indexOf(oldWriter), 1);
    oldWriter.id = 400; f.deployments.push(oldWriter);
    f.statuses[400] = f.statuses[101].map(s => ({ ...s, deployment_url: s.deployment_url.replace('/101', '/400') }));
    assert.deepEqual(await componentBaselines({ api: f.api, target: 'preview' }), { native: null, web: null });
});
test('only bounded relevant history is read; older unrelated workflows do not obscure newer complete writers', async () => {
    const f = componentHistory(); f.deployments.unshift({ id: 1, sha: source, environment: 'Preview' });
    const result = await componentBaselines({ api: f.api, target: 'preview' });
    assert.equal(result.native.runId, 10); assert.equal(result.web.runId, 20);
    assert.ok(!f.requests.some(p => p.startsWith('deployments/1/')));
    assert.equal(f.requests.filter(p => /attempts\/1\/jobs/.test(p)).length, 2);
    assert.ok(f.requests.filter(p => p.includes('/statuses?')).every(p => p.endsWith('per_page=100')));
});
for (const target of ['preview', 'production']) {
    test(`${target}: missing same-environment nonwriter history blocks admission`, async () => {
        const f = componentHistory(target); f.addRun(30, 'native', 'cleanup-qualification'); f.inactivate();
        if (target === 'preview') f.deployments.splice(f.deployments.findIndex(d => d.id === 300), 1);
        else f.statuses[300] = [];
        assert.deepEqual(await componentBaselines({ api: f.api, target }), { native: null, web: null });
    });
}
