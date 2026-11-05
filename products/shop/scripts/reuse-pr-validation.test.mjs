import { protectedConfig } from "./protected-config.mjs";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { protectedRuntimeRecord } from './pr-validation-runtime.mjs';
import { downloadPrRuntime, reusePrValidation, unchangedPrPolicy } from './reuse-pr-validation.mjs';
import { validationRuntime } from './validation-inputs.mjs';
const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40), source = 'd'.repeat(40), tree = 'e'.repeat(40);
const repo = { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } };
const runtime = { toolchain: { node: 'v24.13.1', platform: 'linux', arch: 'x64', imageOS: 'ubuntu24', imageVersion: '20260921.1' }, environmentDigest: 'f'.repeat(64) };
function fixture(change = () => { }) {
    const pull = { number: 12, merged: true, state: 'closed', merge_commit_sha: source,
        base: { sha: base, ref: 'main', repo: structuredClone(repo) }, head: { sha: head, ref: 'feature', repo: structuredClone(repo) } };
    const run = { id: 42, head_sha: head, head_branch: 'feature', repository: structuredClone(repo), head_repository: structuredClone(repo),
        run_attempt: 1, event: 'pull_request', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
    const main = { sha: source, tree: { sha: tree }, parents: [{ sha: base }] };
    const tested = { sha: merge, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] };
    const names = ['Checkout protected policy', 'Prepare validation runtime', 'Record protected runtime', 'Preserve protected runtime', 'Checkout tested merge', 'Check repository without restored caches'];
    const job = { name: 'check', run_id: 42, run_attempt: 1, head_sha: head, conclusion: 'success', steps: names.map((name, index) => ({
            name, number: index + 1, conclusion: 'success', started_at: `2026-09-22T01:00:${index}0Z`, completed_at: `2026-09-22T01:00:${index}9Z`
        })) };
    const artifact = { id: 900, name: 'pr-validation-runtime-42-1', expired: false, created_at: '2026-09-22T01:00:35Z',
        workflow_run: { id: 42, repository_id: repo.id, head_repository_id: repo.id, head_sha: head } };
    const record = { schemaVersion: 1, scope: 'protected-pr-runtime-v1', cachePolicy: 'fresh-without-restored-caches-v1', runId: 42, attempt: 1, pullNumber: 12, baseSha: base, headSha: head, mergeSha: merge, ...structuredClone(runtime) };
    const state = { pull, run, main, tested, job, artifact, record, policy: true };
    change(state);
    const api = async (path) => {
        if (path === `commits/${source}/pulls?per_page=100`)
            return [pull];
        if (path === 'pulls/12')
            return pull;
        if (path === `git/commits/${source}`)
            return main;
        if (path === `git/commits/${merge}`)
            return tested;
        if (path === `actions/workflows/ci.yml/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=100`)
            return { total_count: 2, workflow_runs: [{ ...run, id: 41, conclusion: 'skipped' }, run] };
        if (path === 'actions/runs/42/attempts/1/jobs?per_page=100')
            return { total_count: 1, jobs: [job] };
        if (path === 'actions/runs/42/artifacts?per_page=100')
            return { total_count: 1, artifacts: [artifact] };
        assert.fail(`Unexpected request: ${path}`);
    };
    return { state, api, sha: source, branch: 'main', repository: 'bentbrain/bent-mono', currentRunId: 100,
        report: () => { }, runtime: structuredClone(runtime), policy: (before, after) => { assert.equal(before, base); assert.equal(after, source); return state.policy; },
        readRuntime: async (value) => { assert.equal(value.id, 900); return record; } };
}
function parallelFixture(change = () => { }) {
    const input = fixture(), original = input.api;
    const roles = ['repository', 'browser (1)', 'browser (2)'];
    const jobs = roles.map(name => {
        const job = structuredClone(input.state.job);
        job.name = name;
        job.steps[5].name = name === 'repository' ? 'Check repository without restored caches' : 'Check browser without restored caches';
        return job;
    });
    const aggregate = { ...structuredClone(input.state.job), steps: [{ name: 'Aggregate validation', conclusion: 'success' }] };
    const artifacts = roles.map((name, index) => ({ ...structuredClone(input.state.artifact), id: 900 + index,
        name: `pr-validation-runtime-42-1-${name === 'repository' ? name : `browser-${index}`}` }));
    const records = roles.map(validationJob => ({ ...structuredClone(input.state.record), schemaVersion: 2,
        scope: 'protected-pr-runtime-v2', validationJob }));
    const state = { jobs, aggregate, artifacts, records };
    change(state);
    return { ...input, api: async (path) => path.endsWith('/jobs?per_page=100')
            ? { total_count: jobs.length + 1, jobs: [aggregate, ...jobs] }
            : path.endsWith('/artifacts?per_page=100') ? { total_count: artifacts.length, artifacts } : original(path),
        readRuntime: async (artifact) => records[artifact.id - 900] };
}
test('parallel validation requires fresh repository and both browser shards, each bound to protected runtime and the squash tree', async () => {
    assert.equal(await reusePrValidation(parallelFixture()), 42);
    for (const mutate of [
        s => { s.jobs.pop(); }, s => { s.jobs.push(s.jobs[1]); },
        s => { s.aggregate.conclusion = 'failure'; }, s => { s.aggregate.steps[0].conclusion = 'skipped'; },
        s => { s.jobs[1].conclusion = 'failure'; }, s => { s.jobs[2].run_attempt = 2; },
        s => { s.jobs[1].steps[5].name = 'Check browser with caches'; },
        s => { s.artifacts.pop(); }, s => { s.artifacts[2].created_at = '2026-09-22T01:00:55Z'; },
        s => { s.records[2].validationJob = 'browser (1)'; },
        s => { s.records[1].toolchain.imageVersion = 'other'; },
        s => { s.records[1].mergeSha = head; },
    ])
        assert.equal(await reusePrValidation(parallelFixture(mutate)), undefined);
});
test('a successful first-attempt PR check with protected runtime and the exact squash tree is reusable', async () => {
    assert.equal(await reusePrValidation(fixture()), 42);
    // Upload and checkout can share a server timestamp; PR execution must still
    // start strictly later than artifact creation.
    assert.equal(await reusePrValidation(fixture(s => {
        s.artifact.created_at = '2026-09-22T01:00:40Z';
        s.job.steps[3].completed_at = '2026-09-22T01:00:40Z';
    })), 42);
});
test('untrusted, changed, incomplete or ambiguous evidence always falls back to full checks', async () => {
    const mutations = [
        s => { s.pull.merged = false; }, s => { s.pull.state = 'open'; }, s => { s.pull.merge_commit_sha = head; },
        s => { s.pull.base.repo.owner.id = 1; }, s => { s.pull.head.repo.id = 1; }, s => { s.pull.base.ref = 'feature'; },
        s => { s.main.tree.sha = head; }, s => { s.main.parents.push({ sha: head }); }, s => { s.tested.parents[0].sha = head; },
        s => { s.tested.parents[1].sha = base; }, s => { s.tested.tree.sha = base; }, s => { s.tested.sha = head; }, s => { s.policy = false; },
        s => { s.run.event = 'workflow_dispatch'; }, s => { s.run.path = '.github/workflows/other.yml'; }, s => { s.run.head_sha = source; },
        s => { s.run.head_repository.id = 1; }, s => { s.run.repository.owner.id = 1; }, s => { s.run.run_attempt = 2; },
        s => { s.run.conclusion = 'failure'; }, s => { s.run.status = 'in_progress'; }, s => { s.run.head_branch = 'other'; },
        s => { s.job.conclusion = 'failure'; }, s => { s.job.run_attempt = 2; }, s => { s.job.run_id = 50; },
        s => { s.job.steps[5].conclusion = 'skipped'; }, s => { s.job.steps[2].name = 'PR-authored runtime'; },
        s => { s.job.steps[4].number = 1; }, s => { s.job.steps.push(s.job.steps[2]); },
        s => { s.artifact.created_at = '2026-09-22T01:00:45Z'; }, s => { s.artifact.created_at = '2026-09-22T01:00:40Z'; },
        s => { s.artifact.created_at = '2026-09-22T00:00:00Z'; }, s => { s.artifact.created_at = 'invalid'; },
        s => { s.artifact.workflow_run.id = 999; }, s => { s.artifact.expired = true; }, s => { s.artifact.name += '-replacement'; },
        s => { s.record.baseSha = head; }, s => { s.record.headSha = source; }, s => { s.record.runId = 99; },
        s => { s.record.cachePolicy = 'cached'; }, s => { s.record.attempt = 2; }, s => { s.record.pullNumber = 13; }, s => { s.record.scope = 'PR-authored'; },
        s => { s.record.environmentDigest = '0'.repeat(64); }, s => { s.record.toolchain.node = 'v24.14.0'; },
        s => { s.record.toolchain.imageVersion = '20260922.1'; },
    ];
    for (const [index, change] of mutations.entries())
        assert.equal(await reusePrValidation(fixture(change)), undefined, `mutation ${index}`);
    for (const change of [{ branch: 'feature' }, { repository: 'fork/repo' }, { runtime: null }, { currentRunId: 42 },
        { api: async () => { throw Error('Permissions or evidence unavailable'); } }, { readRuntime: async () => null }])
        assert.equal(await reusePrValidation({ ...fixture(), ...change }), undefined);
});
test('pagination uncertainty and duplicate artifacts cannot establish reuse', async () => {
    for (const endpoint of ['commits/', 'actions/workflows/', '/jobs?', '/artifacts?']) {
        const input = fixture(), original = input.api;
        input.api = async (path) => {
            const result = await original(path);
            if (!path.includes(endpoint))
                return result;
            if (Array.isArray(result))
                return Array.from({ length: 100 }, () => result[0]);
            return { ...result, total_count: 101 };
        };
        assert.equal(await reusePrValidation(input), undefined, endpoint);
    }
    const input = fixture(), original = input.api;
    input.api = async (path) => { const result = await original(path); return path.includes('/artifacts?') ? { total_count: 2, artifacts: [result.artifacts[0], result.artifacts[0]] } : result; };
    assert.equal(await reusePrValidation(input), undefined);
});
test('protected recording rejects forks, wrong checkout, reruns and unsupported runtime', () => {
    const event = { pull_request: { number: 12, labels: [{ name: 'ci:release-candidate' }], base: { sha: base, ref: 'main', repo }, head: { sha: head, repo } } };
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'check', GITHUB_REPOSITORY_ID: String(repo.id),
        GITHUB_REPOSITORY_OWNER_ID: String(repo.owner.id), GITHUB_RUN_ID: '42', GITHUB_SHA: merge, GITHUB_REF: 'refs/pull/12/merge' };
    const record = protectedRuntimeRecord(event, env, base, runtime);
    assert.equal(record.mergeSha, merge);
    assert.equal(record.baseSha, base);
    assert.equal(record.cachePolicy, 'fresh-without-restored-caches-v1');
    const repositoryRecord = protectedRuntimeRecord(event, { ...env, GITHUB_JOB: 'repository' }, base, runtime);
    assert.equal(repositoryRecord.schemaVersion, 2);
    assert.equal(repositoryRecord.validationJob, 'repository');
    for (const shard of ['1', '2']) {
        const browserRecord = protectedRuntimeRecord(event, { ...env, GITHUB_JOB: 'browser', PR_VALIDATION_SHARD: shard }, base, runtime);
        assert.equal(browserRecord.validationJob, `browser (${shard})`);
    }
    for (const shard of ['', '0', '3', '1/2'])
        assert.equal(protectedRuntimeRecord(event, { ...env, GITHUB_JOB: 'browser', PR_VALIDATION_SHARD: shard }, base, runtime), null);
    for (const change of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_JOB: 'release' }, { GITHUB_REPOSITORY_ID: '1' }])
        assert.equal(protectedRuntimeRecord(event, { ...env, ...change }, base, runtime), null);
    assert.equal(protectedRuntimeRecord({ pull_request: { ...event.pull_request, labels: [] } }, env, base, runtime), null);
    assert.equal(protectedRuntimeRecord(event, env, head, runtime), null);
    assert.equal(protectedRuntimeRecord(event, env, base, null), null);
    assert.equal(protectedRuntimeRecord({ pull_request: { ...event.pull_request, head: { sha: head, repo: { id: 1 } } } }, env, base, runtime), null);
    assert.equal(validationRuntime({ env: { ImageOS: 'ubuntu24', ImageVersion: '20260921.1', NODE_OPTIONS: '--import=unsafe' }, node: 'v24.13.1', platform: 'linux', arch: 'x64' }), null);
});
test('unknown files, policy edits and moving a policy file into application source reject reuse', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pr-policy-'));
    const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    try {
        git(['init', '--quiet']);
        git(['config', 'user.name', 'Fixture']);
        git(['config', 'user.email', 'fixture@example.invalid']);
        await writeFile(join(directory, 'policy.json'), '{}');
        git(['add', '.']);
        git(['commit', '--quiet', '-m', 'base']);
        const before = git(['rev-parse', 'HEAD']);
        git(['mv', 'policy.json', 'README.md']);
        git(['commit', '--quiet', '-am', 'rename']);
        const after = git(['rev-parse', 'HEAD']);
        assert.equal(unchangedPrPolicy(before, after, (a, b) => git(['diff', '--no-renames', '--name-only', '-z', a, b])), false);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
    for (const path of ['package.json', 'bun.lock', '.github/workflows/ci.yml', 'scripts/check-ci.mjs', 'apps/web/next.config.ts',
        'workers/api/package.json', 'patches/dependency.patch', 'apps/web/.env', 'unknown/path'])
        assert.equal(unchangedPrPolicy(base, source, () => path), false, path);
    assert.equal(unchangedPrPolicy(base, source, () => 'apps/web/src/page.tsx\0workers/api/src/index.ts\0'), true);
});
test('runtime download uses an immutable artifact ID and validates the archive digest and sole record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pr-archive-'));
    try {
        await writeFile(join(directory, 'pr-validation-runtime.json'), JSON.stringify({ test: true }));
        execFileSync('zip', ['-q', 'fixture.zip', 'pr-validation-runtime.json'], { cwd: directory });
        const archive = await readFile(join(directory, 'fixture.zip'));
        const artifact = { id: 900, size_in_bytes: archive.length, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
        const execute = (command, args, options) => {
            if (command === 'gh') {
                assert.deepEqual(args, ['api', 'repos/bentbrain/bent-mono/actions/artifacts/900/zip']);
                return archive;
            }
            return execFileSync(command, args, options);
        };
        assert.deepEqual(await downloadPrRuntime(artifact, 'fixture', execute), { test: true });
        assert.equal(await downloadPrRuntime({ ...artifact, digest: `sha256:${'0'.repeat(64)}` }, 'fixture', execute), null);
        assert.equal(await downloadPrRuntime({ ...artifact, size_in_bytes: 1000000 }, 'fixture', () => assert.fail()), null);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('workflow captures protected evidence before PR checkout and pins the tested Node version', async () => {
    const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const steps = ['Checkout protected policy', 'Prepare validation runtime', 'Record protected runtime',
        'Preserve protected runtime', 'Checkout tested merge', 'Check repository without restored caches'];
    for (let i = 1; i < steps.length; i++)
        assert.ok(ci.indexOf(`name: ${steps[i - 1]}`) < ci.indexOf(`name: ${steps[i]}`));
    assert.ok(ci.includes('ref: ${{ github.event.pull_request.base.sha }}'));
    assert.ok(ci.includes('ref: ${{ github.sha }}'));
    assert.ok(ci.includes('node-version: ${{ steps.runtime.outputs.node-version }}'));
    for (const name of ['Checkout protected policy', 'Prepare validation runtime', 'Record protected runtime', 'Preserve protected runtime'])
        assert.ok(ci.includes(`name: ${name}\n        if: contains(github.event.pull_request.labels.*.name, 'ci:release-candidate')`));
    assert.equal(ci.match(/persist-credentials: false/g)?.length, 4);
    assert.match(ci, /needs: \[repository, browser\]/);
    assert.match(ci, /shard: \[1, 2\]/);
    assert.match(ci, /if: always\(\) && github\.event\.pull_request\.draft == false/);
    assert.match(ci, /test "\$REPOSITORY_RESULT" = success\s+test "\$BROWSER_RESULT" = success/);
    assert.doesNotMatch(ci, /pull_request_target|: write|secrets\.|TURBO_TOKEN/);
    const action = await readFile(new URL('../.github/actions/check/action.yml', import.meta.url), 'utf8');
    assert.ok(action.includes('node-version: ${{ inputs.node-version }}'));
});
test('fallback reasons are observable without logging private response content', async () => {
    const reasons = [];
    const input = fixture(s => { s.policy = false; });
    assert.equal(await reusePrValidation({ ...input, report: reason => reasons.push(reason) }), undefined);
    assert.match(reasons[0], /policy differs/);
    await reusePrValidation({ ...fixture(), report: reason => reasons.push(reason), api: async () => { throw Error('private-token response'); } });
    assert.match(reasons[1], /independently verified/);
    assert.ok(!reasons.join(' ').includes('private-token'));
});
test('only the fresh candidate step can qualify, with no restored dependency, task or browser caches', async () => {
    const ordinary = fixture(s => { s.job.steps[5].name = 'Check repository with caches'; });
    assert.equal(await reusePrValidation(ordinary), undefined);
    const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    assert.ok(ci.includes("contains(github.event.pull_request.labels.*.name, 'ci:release-candidate')"));
    assert.match(ci, /name: Check repository without restored caches[\s\S]*fresh: 'true'/);
    const action = await readFile(new URL('../.github/actions/check/action.yml', import.meta.url), 'utf8');
    for (const name of ['Install Node.js', 'Restore task and Next.js caches', 'Restore local browser'])
        assert.ok(action.includes(`name: ${name}\n      if: inputs.fresh != 'true'`));
    assert.match(action, /name: Install fresh validation Node.js[\s\S]*package-manager-cache: false/);
    assert.equal(action.match(/CI_FRESH_VALIDATION: \$\{\{ inputs.fresh \}\}/g)?.length, 2);
});
