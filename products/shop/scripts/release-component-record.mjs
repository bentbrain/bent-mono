import { protectedConfig } from './protected-config.mjs';
import { githubApi } from './github-actions.mjs';
import { isDeepStrictEqual as equal } from 'node:util';

const repository = 'bentbrain/bent-mono';
const positiveId = n => Number.isSafeInteger(n) && n > 0;
const check = (value, reason) => { if (!value) throw Error(`Component release record stopped: ${reason}`); };
export const componentTask = component => `shop-component-${component}`;
const payload = (component, runId, jobId, source) => ({ schemaVersion: 1, component, runId, jobId, source });

// These records are written by the protected writer after its runtime operation
// succeeds. Transient Preview and Production records are exempt from GitHub's
// environment-wide automatic inactivation. Later writers are still fenced by
// the job/run inventory.
export async function corroborateComponentRecord({ api, target, component, run, job }) {
    const environment = target === 'preview' ? 'Preview' : 'Production';
    const task = componentTask(component);
    const records = await api(`deployments?environment=${environment}&task=${task}&per_page=100`);
    if (!Array.isArray(records) || !records.length || records.length >= 100 ||
        new Set(records.map(r => r?.id)).size !== records.length || records.some(r => !positiveId(r?.id))) return false;
    const record = [...records].sort((a, b) => b.id - a.id)[0];
    if (records.filter(r => r.payload?.runId === run.id).length !== 1 || record.environment !== environment || record.task !== task ||
        record.sha !== run.head_sha || record.ref !== run.head_sha || record.transient_environment !== (target === 'preview') ||
        record.production_environment !== (target === 'production') ||
        !equal(record.payload, payload(component, run.id, job.id, run.head_sha))) return false;
    const statuses = await api(`deployments/${record.id}/statuses?per_page=100`);
    if (!Array.isArray(statuses) || !statuses.length || statuses.length >= 100 || statuses[0]?.state !== 'success') return false;
    return statuses.every((status, i) => positiveId(status?.id) && status.environment === environment &&
        status.deployment_url === `https://api.github.com/repos/${repository}/deployments/${record.id}` &&
        status.log_url === job.html_url && (i === 0 ? status.state === 'success' : ['pending', 'queued', 'in_progress'].includes(status.state)) &&
        Number.isFinite(Date.parse(status.created_at)) && (i === 0 || status.id < statuses[i - 1].id && Date.parse(status.created_at) <= Date.parse(statuses[i - 1].created_at)));
}

export async function publishComponentRecord({ env = process.env, api, post }) {
    const component = env.SHOP_RELEASE_COMPONENT, target = env.SHOP_RELEASE_TARGET;
    check(['native', 'web'].includes(component) && ['preview', 'production'].includes(target), 'component and target required.');
    const workflow = component === 'native' ? `native-${target === 'preview' ? 'development' : 'production'}.yml` : target === 'preview' ? 'deploy.yml' : 'web-production.yml';
    const writer = component === 'native' ? target === 'preview' ? 'build' : 'verify' : target === 'preview' ? 'deploy' : 'release';
    const completedStep = component === 'native' ? target === 'preview' ? 'Verify candidate and execute only the selected guarded Development operation' :
        'Verify evidence and perform only the selected runtime operation' : target === 'preview' ? 'Deploy storefront' : 'Stage, verify and promote storefront';
    check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === repository && env.GITHUB_REPOSITORY_ID === protectedConfig('githubRepositoryId') &&
        env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig('githubOwnerId') && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
        env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_RUN_ATTEMPT === '1' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') &&
        /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && env.GITHUB_JOB === writer &&
        env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/${workflow}@refs/heads/main`, 'protected first-attempt main writer required.');
    check(component !== 'native' || (target === 'preview' ? env.NATIVE_OPERATION === 'release' : ['release', 'promote'].includes(env.NATIVE_OPERATION)), 'release operation required.');
    const runId = Number(env.GITHUB_RUN_ID), source = env.GITHUB_SHA;
    const run = await api(`actions/runs/${runId}`), inventory = await api(`actions/runs/${runId}/attempts/1/jobs?per_page=100`);
    check(run?.id === runId && run.head_sha === source && run.head_branch === 'main' && run.run_attempt === 1 && run.path === `.github/workflows/${workflow}` &&
        run.event === 'workflow_dispatch' && run.repository?.id === Number(protectedConfig('githubRepositoryId')) &&
        run.repository?.owner?.id === Number(protectedConfig('githubOwnerId')) && run.head_repository?.id === Number(protectedConfig('githubRepositoryId')), 'authenticated writer identity.');
    check(Array.isArray(inventory?.jobs) && inventory.jobs.length < 100 && inventory.total_count === inventory.jobs.length, 'complete job inventory.');
    const matches = inventory.jobs.filter(j => j.name === writer);
    const job = matches[0];
    check(matches.length === 1 && positiveId(job?.id) && job.run_id === runId && job.run_attempt === 1 && job.head_sha === source &&
        job.html_url === `https://github.com/${repository}/actions/runs/${runId}/job/${job.id}` &&
        job.steps?.filter(s => s.name === completedStep && s.status === 'completed' && s.conclusion === 'success').length === 1, 'successful runtime verification step required.');
    const environment = target === 'preview' ? 'Preview' : 'Production', task = componentTask(component);
    const previous = await api(`deployments?environment=${environment}&task=${task}&per_page=100`);
    check(Array.isArray(previous) && previous.length < 100 && !previous.some(r => r.payload?.runId === runId), 'record exists or inventory is ambiguous; inspect rather than retry.');
    const record = await post('deployments', { ref: source, task, environment, auto_merge: false, required_contexts: [],
        transient_environment: target === 'preview', production_environment: target === 'production', payload: payload(component, runId, job.id, source) });
    check(positiveId(record?.id), 'creation acknowledgement uncertain; inspect rather than retry.');
    await post(`deployments/${record.id}/statuses`, { state: 'success', environment, auto_inactive: false, log_url: job.html_url,
        description: `Verified Shop ${component} release` });
    check(await corroborateComponentRecord({ api, target, component, run, job }), 'record readback differs; inspect rather than retry.');
    return { component, source, runId, deploymentId: record.id };
}

if (import.meta.main) {
    const token = process.env.GH_TOKEN;
    try {
        check(typeof token === 'string' && token.length > 0, 'explicit Actions token required.');
        const api = githubApi({ token, repository });
        const post = async (path, body) => {
            check(path === 'deployments' || /^deployments\/[1-9][0-9]*\/statuses$/.test(path), 'fixed metadata endpoint.');
            const response = await fetch(`https://api.github.com/repos/bentbrain/bent-mono/${path}`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, body: JSON.stringify(body),
            });
            check(response.status === 201, 'metadata write acknowledgement uncertain; inspect rather than retry.');
            return response.json();
        };
        console.info(JSON.stringify(await publishComponentRecord({ api, post })));
    } catch { console.error('Component release record was not confirmed. Inspect this run before another release.'); process.exitCode = 1; }
}
