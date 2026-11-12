import { protectedConfig } from './protected-config.mjs';
import assert from 'node:assert/strict';
export const historySource = 'a'.repeat(40);
export function componentHistory(target = 'preview') {
    const environment = target === 'preview' ? 'Preview' : 'Production';
    const suffix = `main · ${historySource} · [manual]`;
    const runs = {}, jobs = {}, deployments = [], statuses = {}, requests = [];
    const time = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    function addRun(id, kind, operation = target === 'preview' ? 'release' : 'promote') {
        const native = kind === 'native', smoke = kind === 'smoke';
        const names = native ? target === 'preview' ? ['check', 'build'] : ['verify'] : smoke ? ['smoke'] : target === 'preview' ? ['validate', 'deploy', 'e2e'] : ['validate', 'release'];
        runs[id] = { id, path: `.github/workflows/${native ? `native-${target === 'preview' ? 'development' : 'production'}` : smoke ? 'preview-smoke' : target === 'preview' ? 'deploy' : 'web-production'}.yml`,
            display_title: native ? `Native ${target === 'preview' ? 'development' : 'production'} · ${operation} · full · - · - · ${suffix}` : smoke ? `Preview smoke · ${suffix}` : target === 'preview' ? `Storefront · development · preview=true · full=false · ${suffix}` : `Storefront Production · ${suffix}`,
            head_sha: historySource, head_branch: 'main', event: 'workflow_dispatch', run_attempt: 1, status: 'completed', conclusion: 'success',
            repository: { id: Number(protectedConfig('githubRepositoryId')), owner: { id: Number(protectedConfig('githubOwnerId')) } }, head_repository: { id: Number(protectedConfig('githubRepositoryId')) } };
        jobs[id] = { total_count: names.length, jobs: names.map((name, index) => {
            const jobId = id * 10 + index, deploymentId = jobId;
            const start = deployments.length * 4 + 1;
            const log = `https://github.com/bentbrain/bent-mono/actions/runs/${id}/job/${jobId}`;
            deployments.push({ id: deploymentId, environment, sha: historySource });
            statuses[deploymentId] = ['success', 'in_progress', 'queued', 'waiting'].map((state, i) => ({ id: deploymentId * 10 + 4 - i, state, environment,
                deployment_url: `https://api.github.com/repos/bentbrain/bent-mono/deployments/${deploymentId}`, log_url: log, created_at: time(start + 3 - i) }));
            return { id: jobId, name, run_id: id, run_attempt: 1, head_sha: historySource, head_branch: 'main', html_url: log, status: 'completed', conclusion: 'success' };
        }) };
        return runs[id];
    }
    addRun(10, 'native'); addRun(20, 'web');
    // GitHub marks each earlier successful environment job inactive when the next succeeds.
    function inactivate() {
        for (let i = 0; i < deployments.length - 1; i++) {
            const d = deployments[i], next = deployments[i + 1];
            if (statuses[d.id][0].state === 'inactive') continue;
            statuses[d.id].unshift({ ...statuses[d.id][0], id: d.id * 10 + 5, state: 'inactive', created_at: statuses[next.id].find(s => s.state === 'success').created_at });
        }
    }
    inactivate();
    const api = async (path, body) => {
        assert.equal(body, undefined, 'History discovery is read-only'); requests.push(path);
        if (path === `deployments?environment=${environment}&per_page=100`) return structuredClone(deployments);
        let match = /^deployments\/(\d+)\/statuses\?per_page=(100|1)$/.exec(path);
        if (match) return structuredClone(match[2] === '1' ? statuses[match[1]].slice(0, 1) : statuses[match[1]]);
        match = /^actions\/runs\/(\d+)\/attempts\/1\/jobs\?per_page=100$/.exec(path);
        if (match) return structuredClone(jobs[match[1]]);
        match = /^actions\/runs\/(\d+)$/.exec(path);
        if (match) return structuredClone(runs[match[1]]);
        throw Error(`Unexpected synthetic request ${path}`);
    };
    return { api, runs, jobs, deployments, statuses, requests, addRun, inactivate, environment };
}
