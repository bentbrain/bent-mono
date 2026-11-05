import { protectedConfig } from "./protected-config.mjs";
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { validationRuntime } from './validation-inputs.mjs';
const repository = 'bentbrain/bent-mono';
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
const personal = repo => repo?.id === Number(protectedConfig("githubRepositoryId")) && repo.owner?.id === Number(protectedConfig("githubOwnerId"));
const positive = value => Number.isSafeInteger(value) && value > 0;
const complete = (result, key) => Array.isArray(result[key]) && Number.isSafeInteger(result.total_count) &&
    result.total_count === result[key].length && result.total_count <= 100;
// Unknown paths are policy. Package/configuration, CI, scripts, lockfiles and
// patches must be unchanged from the independently verified protected parent.
export function unchangedPrPolicy(base, source, diff = (before, after) => execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', before, after], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) {
    if (!sha(base) || !sha(source))
        return false;
    return diff(base, source).split('\0').filter(Boolean).every(path => /^(?:apps\/web\/(?:src|public|e2e)\/|workers\/(?:api|video-renderer)\/src\/|packages\/[^/]+\/src\/|assets\/|docs\/)/.test(path) || path === 'README.md');
}
export async function downloadPrRuntime(artifact, token, execute = execFileSync, filename = 'pr-validation-runtime.json') {
    if (!/^pr-validation-runtime(?:-repository|-browser-[12])?\.json$/.test(filename))
        return null;
    if (!positive(artifact.id) || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') ||
        !positive(artifact.size_in_bytes) || artifact.size_in_bytes > 16384)
        return null;
    // Download by immutable ID, not a name that PR code could replace after our
    // metadata read. Verify GitHub's archive digest before reading the one record.
    const archive = execute('gh', ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { env: { ...process.env, GH_TOKEN: token }, maxBuffer: 16384, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (`sha256:${createHash('sha256').update(archive).digest('hex')}` !== artifact.digest)
        return null;
    const directory = await mkdtemp(join(tmpdir(), 'pr-runtime-'));
    try {
        const file = join(directory, 'artifact.zip');
        await writeFile(file, archive, { mode: 0o600 });
        const options = { encoding: 'utf8', maxBuffer: 4096, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] };
        if (execute('unzip', ['-Z1', file], options).trim() !== filename)
            return null;
        return JSON.parse(execute('unzip', ['-p', file, filename], options));
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
function runtimeArtifact(artifacts, run, job, suffix = '') {
    if (!complete(artifacts, 'artifacts'))
        return undefined;
    const names = ['Checkout protected policy', 'Prepare validation runtime', 'Record protected runtime',
        'Preserve protected runtime', 'Checkout tested merge', job.name.startsWith('browser (')
            ? 'Check browser without restored caches' : 'Check repository without restored caches'];
    const steps = names.map(name => job.steps?.filter(step => step.name === name));
    if (steps.some(matches => matches?.length !== 1))
        return undefined;
    const ordered = steps.map(matches => matches[0]);
    if (ordered.some((step, index) => step.conclusion !== 'success' || !positive(step.number) ||
        (index > 0 && step.number <= ordered[index - 1].number)))
        return undefined;
    if (ordered.some((step, index) => !(Date.parse(step.started_at) <= Date.parse(step.completed_at)) ||
        (index > 0 && !(Date.parse(ordered[index - 1].completed_at) <= Date.parse(step.started_at)))))
        return undefined;
    const [, , record, upload, , execution] = ordered;
    const candidates = artifacts.artifacts.filter(item => item.name === `pr-validation-runtime-${run.id}-1${suffix}`);
    if (candidates.length !== 1)
        return undefined;
    const artifact = candidates[0], created = Date.parse(artifact.created_at);
    // GitHub timestamps have second precision. Checkout only reads PR files;
    // the named composite is the first step that can execute them. Requiring
    // a strictly earlier server timestamp excludes late replacements.
    if (!positive(artifact.id) || artifact.expired !== false || artifact.workflow_run?.id !== run.id ||
        artifact.workflow_run.repository_id !== Number(protectedConfig("githubRepositoryId")) || artifact.workflow_run.head_repository_id !== Number(protectedConfig("githubRepositoryId")) ||
        artifact.workflow_run.head_sha !== run.head_sha || !Number.isFinite(created) ||
        !(created >= Date.parse(record.started_at) && created <= Date.parse(upload.completed_at) && created < Date.parse(execution.started_at)))
        return undefined;
    return artifact;
}
export async function reusePrValidation({ api, sha: source, branch, repository: repo, currentRunId, env = process.env, runtime = validationRuntime({ env }), policy = unchangedPrPolicy, readRuntime = (artifact, filename) => downloadPrRuntime(artifact, env.GH_TOKEN, execFileSync, filename), report = reason => console.log(`PR validation reuse: ${reason}.`) }) {
    const miss = reason => { report(reason); return undefined; };
    if (repo !== repository || branch !== 'main' || !sha(source) || !runtime)
        return miss('unsupported repository, branch or runtime');
    try {
        const associated = await api(`commits/${source}/pulls?per_page=100`);
        if (!Array.isArray(associated) || associated.length >= 100)
            return miss('incomplete associated PR inventory');
        const matches = associated.filter(pull => pull.merge_commit_sha === source && pull.base?.ref === 'main' && personal(pull.base.repo));
        if (matches.length !== 1 || !positive(matches[0].number))
            return miss('no unique main squash PR');
        const pull = await api(`pulls/${matches[0].number}`);
        if (!pull.merged || pull.state !== 'closed' || pull.merge_commit_sha !== source || !personal(pull.base?.repo) ||
            !personal(pull.head?.repo) || pull.base.ref !== 'main' || !sha(pull.head.sha))
            return miss('PR merge or repository identity differs');
        // Only a squash merge directly onto the tested base qualifies. A changed
        // main base, merge commit, rebase merge or later edit gets full validation.
        const main = await api(`git/commits/${source}`);
        if (main.sha !== source || main.parents?.length !== 1 || !sha(main.parents[0].sha) || !sha(main.tree?.sha) ||
            !policy(main.parents[0].sha, source))
            return miss('squash parent or validation policy differs');
        const listing = await api(`actions/workflows/ci.yml/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=100`);
        if (!complete(listing, 'workflow_runs'))
            return miss('incomplete CI run inventory');
        const run = listing.workflow_runs.filter(item => item.conclusion !== 'skipped').sort((a, b) => b.id - a.id)[0];
        if (!run || !positive(run.id) || String(run.id) === String(currentRunId) || run.event !== 'pull_request' ||
            run.path !== '.github/workflows/ci.yml' || run.head_sha !== pull.head.sha || run.head_branch !== pull.head.ref ||
            !personal(run.repository) || !personal(run.head_repository) || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'success')
            return miss('latest CI is not eligible successful first-attempt validation');
        const jobs = await api(`actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
        if (!complete(jobs, 'jobs'))
            return miss('incomplete CI job inventory');
        const checks = jobs.jobs.filter(job => job.name === 'check');
        if (checks.length !== 1 || checks[0].conclusion !== 'success' || checks[0].head_sha !== run.head_sha ||
            checks[0].run_id !== run.id || checks[0].run_attempt !== 1)
            return miss('required check job is missing or ineligible');
        const parallel = checks[0].steps?.some(step => step.name === 'Aggregate validation' && step.conclusion === 'success');
        const roles = parallel ? ['repository', 'browser (1)', 'browser (2)'] : ['check'];
        const artifacts = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
        const records = [];
        for (const role of roles) {
            const matches = jobs.jobs.filter(job => job.name === role);
            if (matches.length !== 1 || matches[0].conclusion !== 'success' || matches[0].head_sha !== run.head_sha ||
                matches[0].run_id !== run.id || matches[0].run_attempt !== 1)
                return miss('required validation job is missing or ineligible');
            const suffix = role === 'check' ? '' : role === 'repository' ? '-repository' : `-browser-${role === 'browser (1)' ? 1 : 2}`;
            const artifact = runtimeArtifact(artifacts, run, matches[0], suffix);
            if (!artifact)
                return miss('protected runtime artifact or execution ordering is missing or ineligible');
            const record = await readRuntime(artifact, `pr-validation-runtime${suffix}.json`);
            if (record?.schemaVersion !== (parallel ? 2 : 1) || record.scope !== `protected-pr-runtime-v${parallel ? 2 : 1}` ||
                (parallel && record.validationJob !== role) || record.cachePolicy !== 'fresh-without-restored-caches-v1' || record.runId !== run.id || record.attempt !== 1 ||
                record.pullNumber !== pull.number || record.baseSha !== main.parents[0].sha || record.headSha !== pull.head.sha || !sha(record.mergeSha) ||
                !equal(record.toolchain, runtime.toolchain) || record.environmentDigest !== runtime.environmentDigest)
                return miss('protected runtime, environment or source binding differs');
            records.push(record);
        }
        const record = records[0];
        if (records.some(item => item.mergeSha !== record.mergeSha))
            return miss('validation jobs tested different merge sources');
        // GitHub's Git object, not the receipt's claim, establishes the tested tree
        // and its protected base plus exact PR head parents.
        const tested = await api(`git/commits/${record.mergeSha}`);
        if (tested.sha !== record.mergeSha || tested.tree?.sha !== main.tree.sha || tested.parents?.length !== 2 ||
            tested.parents[0].sha !== record.baseSha || tested.parents[1].sha !== record.headSha)
            return miss('tested Git tree or parents differ from the squash commit');
        report(`accepted first-attempt run ${run.id} for the exact tested tree`);
        return run.id;
    }
    catch {
        // Missing permissions, expired/deleted artifacts, unavailable merge refs,
        // parse failures or uncertain provenance always run the existing checks.
        return miss('evidence could not be independently verified');
    }
}
