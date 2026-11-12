import { protectedConfig } from "./protected-config.mjs";
import { qualificationPolicy } from './release-qualification-policy.mjs';
import { applicationContractPath } from "./contract-consumers.mjs";
import { shippingOnlyPaths, commerceOnlyPaths, commerceBoundary, renderingInputManifest, rendererQualificationReusable } from './rendering-inputs.mjs';
import { gitChanges } from './deployment-plan.mjs';
import { apiOnlyPaths } from './native-api-image.mjs';
import { isDeepStrictEqual } from 'node:util';
import { corroborateComponentRecord } from './release-component-record.mjs';
const all = () => ({ web: true, api: true, renderer: true, notifications: true });
const metadata = path => path.startsWith('docs/') || ['README.md', 'CLAUDE.md',
    'infra/story-video-lambda/development-qualification.json', 'infra/story-video-lambda/production-promotion.json'].includes(path);
export function releaseComponents(paths) {
    if (!Array.isArray(paths))
        return all();
    const result = { web: false, api: false, renderer: false, notifications: false };
    for (const path of paths) {
        if (metadata(path))
            continue;
        if (applicationContractPath(path)) {
            result.web = true;
            result.api = true;
        }
        else if (path.startsWith('shopify/notifications/'))
            result.notifications = true;
        else if (path.startsWith('apps/web/public/mockups/'))
            return all();
        else if (path.startsWith('apps/web/'))
            result.web = true;
        else if (path.startsWith('workers/api/'))
            result.api = true;
        else if (path.startsWith('workers/video-renderer/') || path.startsWith('infra/story-video-lambda/'))
            result.renderer = true;
        else
            return all();
    }
    return result;
}
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const nonwriterOperations = new Set(['plan', 'verify-qualification', 'qualify', 'qualify-all', 'qualify-exhaustion', 'qualify-faults', 'qualify-termination', 'qualify-load', 'monitor', 'inspect-release', 'verify-candidate', 'inspect-image-plan', 'canary', 'cleanup-qualification', 'cleanup-failed-qualification', 'inspect-failed-qualification', 'qualify-components']);
function baselineWorkflow(run, target) {
    const suffix = `main · ${run.head_sha} · `;
    const title = run.display_title ?? '';
    const correlation = /\[(?:manual|release-[a-f0-9-]{36}-\d+)\]$/.exec(title)?.[0];
    if (!correlation || !title.endsWith(suffix + correlation))
        return null;
    const prefix = title.slice(0, -suffix.length - correlation.length);
    const nativeTarget = target === 'production' ? 'production' : 'development';
    if (run.path === `.github/workflows/native-${nativeTarget}.yml`) {
        const match = new RegExp(`^Native ${nativeTarget} · ([a-z-]+) · (?:full|api) · (?:-|native-[1-9][0-9]*) · (?:-|native-[1-9][0-9]*) · $`).exec(prefix);
        if (!match || !(nonwriterOperations.has(match[1]) || ['release', 'promote'].includes(match[1])))
            return null;
        return { component: nonwriterOperations.has(match[1]) ? null : 'native', writer: target === 'production' ? 'verify' : 'build', names: target === 'production' ? ['verify'] : ['check', 'build'] };
    }
    if (target === 'production' && run.path === '.github/workflows/web-production.yml' && prefix === 'Storefront Production · ')
        return { component: 'web', writer: 'release', names: ['validate', 'release'] };
    if (target === 'preview' && run.path === '.github/workflows/deploy.yml' && prefix === 'Storefront · development · preview=true · full=false · ')
        return { component: 'web', writer: 'deploy', names: ['validate', 'deploy', 'e2e'] };
    if (target === 'preview' && run.path === '.github/workflows/preview-smoke.yml' && prefix === 'Preview smoke · ')
        return { component: null, names: ['smoke'] };
    return null;
}
// Read a complete bounded prefix through both newest component runs. Every status
// must bind to one job in its authenticated first-attempt inventory. A later run
// claims its component even when its writer has not completed, preventing fallback.
// Shared environment history identifies candidate writers. A separate active
// component record corroborates them; timestamps never establish supersession.
// Runtime and immutable release evidence remain separate admission requirements.
export async function componentBaselines({ api, target }) {
    if (!['preview', 'production'].includes(target))
        throw Error('Choose preview or production.');
    const environment = target === 'production' ? 'Production' : 'Preview';
    const empty = () => ({ web: null, native: null });
    const deployments = await api(`deployments?environment=${environment}&per_page=100`);
    if (!Array.isArray(deployments) || deployments.length >= 100 ||
        new Set(deployments.map(d => d?.id)).size !== deployments.length ||
        deployments.some(d => !positiveId(d?.id) || d.environment !== environment))
        return empty();
    const runs = new Map(), latest = new Map();
    for (const deployment of deployments.filter(d => !['shop-component-native', 'shop-component-web'].includes(d.task)).sort((a, b) => b.id - a.id)) {
        const statuses = await api(`deployments/${deployment.id}/statuses?per_page=100`);
        if (!Array.isArray(statuses) || !statuses.length || statuses.length >= 100)
            return empty();
        const log = statuses[0]?.log_url;
        const identity = /^https:\/\/github.com\/bentbrain\/bent-mono\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(log ?? '');
        if (!identity)
            return empty();
        const runId = Number(identity[1]), jobId = Number(identity[2]);
        if (!positiveId(runId) || !positiveId(jobId) || statuses.some((s, i) => !positiveId(s?.id) || s.log_url !== log ||
            s.environment !== environment || s.deployment_url !== `https://api.github.com/repos/bentbrain/bent-mono/deployments/${deployment.id}` ||
            !['waiting', 'queued', 'pending', 'in_progress', 'success', 'inactive', 'failure', 'error'].includes(s.state) ||
            !Number.isFinite(Date.parse(s.created_at)) || i > 0 && (s.id >= statuses[i - 1].id || Date.parse(s.created_at) > Date.parse(statuses[i - 1].created_at))))
            return empty();
        if (!runs.has(runId)) {
            const run = await api(`actions/runs/${runId}`);
            const workflow = run && baselineWorkflow(run, target);
            if (!workflow || run.id !== runId || run.repository?.id !== Number(protectedConfig('githubRepositoryId')) ||
                run.repository?.owner?.id !== Number(protectedConfig('githubOwnerId')) || run.head_repository?.id !== Number(protectedConfig('githubRepositoryId')) ||
                run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || !/^[a-f0-9]{40}$/.test(run.head_sha) || run.run_attempt !== 1)
                return empty();
            const inventory = await api(`actions/runs/${runId}/attempts/1/jobs?per_page=100`);
            if (!Array.isArray(inventory?.jobs) || inventory.jobs.length >= 100 || inventory.total_count !== inventory.jobs.length ||
                inventory.jobs.length !== workflow.names.length || new Set(inventory.jobs.map(j => j.name)).size !== workflow.names.length ||
                new Set(inventory.jobs.map(j => j.id)).size !== inventory.jobs.length || inventory.jobs.some(j => !positiveId(j.id) || !workflow.names.includes(j.name) ||
                    j.run_id !== runId || j.run_attempt !== 1 || j.head_sha !== run.head_sha || j.head_branch !== 'main' ||
                    j.html_url !== `https://github.com/bentbrain/bent-mono/actions/runs/${runId}/job/${j.id}`))
                return empty();
            const entry = { run, workflow, jobs: inventory.jobs, records: [] };
            runs.set(runId, entry);
            if (workflow.component) {
                if ((latest.get(workflow.component)?.run.id ?? runId) < runId)
                    return empty();
                if (!latest.has(workflow.component))
                    latest.set(workflow.component, entry);
            }
        }
        const entry = runs.get(runId), job = entry.jobs.find(j => j.id === jobId);
        if (!job || deployment.sha !== entry.run.head_sha || entry.records.some(r => r.job.id === jobId))
            return empty();
        const terminal = statuses.findIndex(s => s.state !== 'inactive');
        const succeeded = terminal >= 0 && statuses[terminal].state === 'success' &&
            statuses.slice(terminal + 1).every(s => ['waiting', 'queued', 'pending', 'in_progress'].includes(s.state)) &&
            job.status === 'completed' && job.conclusion === 'success';
        entry.records.push({ deployment, job, succeeded });
        if (latest.size === 2 && [...runs.values()].every(e => e.records.length === e.jobs.length))
            break;
    }
    if ([...runs.values()].some(e => e.records.length !== e.jobs.length))
        return empty();
    const baseline = empty();
    for (const [component, entry] of latest) {
        const { run, workflow, jobs } = entry;
        const writer = entry.records.find(r => r.job.name === workflow.writer);
        if (entry.records.length !== jobs.length || run.status !== 'completed' || run.conclusion !== 'success' ||
            jobs.some(j => j.status !== 'completed' || j.conclusion !== 'success') || !writer?.succeeded ||
            entry.records.some(r => !r.succeeded) ||
            !await corroborateComponentRecord({ api, target, component, run, job: writer.job }))
            continue;
        baseline[component] = { source: run.head_sha, runId: run.id, deploymentId: writer.deployment.id };
    }
    return baseline;
}
export function componentReleasePlan({ source, target, baselines, rendererBaseline = null, changes = gitChanges, manifest = renderingInputManifest, policyVersion = 3 }) {
    if (![1, 2, 3].includes(policyVersion) || !['preview', 'production', 'qualification'].includes(target) || !/^[a-f0-9]{40}$/.test(source))
        throw Error('Exact source and release target required.');
    const paths = component => baselines?.[component]?.source ? changes(baselines[component].source, source) : undefined;
    const nativePaths = paths('native'), webPaths = paths('web');
    const native = releaseComponents(nativePaths), web = releaseComponents(webPaths);
    const needsNative = native.api || native.renderer;
    // Image eligibility does not prove the separate print executor unchanged.
    // Route known executor inputs through full preparation; the cloud byte/config
    // guard remains authoritative. Historical policies retain their pinned plan.
    const printExecutorChanged = policyVersion === 3 && Array.isArray(nativePaths) && nativePaths.some(path => path.startsWith('workers/api/src/print-') && !path.endsWith('.test.ts') ||
        path === 'workers/api/src/observability.ts' || path === 'packages/contracts/src/limits.ts');
    const mode = !native.renderer && !printExecutorChanged && Array.isArray(nativePaths) && apiOnlyPaths(nativePaths) ? 'api' : 'full';
    const components = { api: native.api, renderer: native.renderer, web: web.web, notifications: native.notifications || web.notifications };
    const useRenderer = ['preview', 'qualification'].includes(target) && mode === 'api' && rendererBaseline &&
        (policyVersion === 3 && rendererBaseline.boundary === commerceBoundary ? commerceOnlyPaths : shippingOnlyPaths)(changes(rendererBaseline.sourceCommit, source)) &&
        manifest(rendererBaseline.sourceCommit, { nodeVersion: rendererBaseline.nodeVersion, boundary: rendererBaseline.boundary ?? 'isolated-printify-webhooks-v1' })?.inputsDigest === rendererBaseline.inputsDigest &&
        rendererQualificationReusable(manifest(rendererBaseline.sourceCommit, { nodeVersion: rendererBaseline.nodeVersion, boundary: rendererBaseline.boundary ?? 'isolated-printify-webhooks-v1' }), manifest(source, { nodeVersion: rendererBaseline.nodeVersion, boundary: rendererBaseline.boundary ?? 'isolated-printify-webhooks-v1' }));
    const stages = [];
    if (needsNative) {
        stages.push({ workflow: `native-${target === 'preview' ? 'development' : 'production'}.yml`, inputs: { operation: target === 'preview' ? 'release' : 'promote', release_mode: mode } });
        if (target === 'preview' && policyVersion === 1)
            stages.push({ workflow: 'native-development.yml', inputs: useRenderer ? { operation: 'qualify-components', renderer_reference: JSON.stringify(rendererBaseline.reference) } : { operation: 'qualify-all' } });
    }
    if (components.web)
        stages.push(target === 'preview' ? { workflow: 'deploy.yml', inputs: { environment: 'development', web_only_preview: true } } : { workflow: 'web-production.yml', inputs: {} });
    if (policyVersion >= 2 && target === 'preview' && needsNative && !components.web)
        stages.push({ workflow: 'preview-smoke.yml', inputs: {} });
    if (target === 'qualification') {
        if (policyVersion < 2 || baselines?.native?.source !== source || !Number.isSafeInteger(baselines.native.runId) || baselines.native.runId <= 0)
            throw Error('Qualification needs the successful live Preview release at this exact source. Deploy Preview first.');
        stages.splice(0, stages.length, { workflow: 'native-development.yml', inputs: {
                operation: useRenderer ? 'qualify-components' : 'qualify-all',
                verify_release: `native-${baselines.native.runId}`,
                ...(useRenderer ? { renderer_reference: JSON.stringify(rendererBaseline.reference) } : {}),
            } });
    }
    return { schemaVersion: policyVersion, source, target, baselines, rendererBaseline, components, mode, stages,
        comparison: { nativePaths: nativePaths ?? null, webPaths: webPaths ?? null },
        ...(policyVersion >= 2 ? { qualification: { ...qualificationPolicy(rendererBaseline ? changes(rendererBaseline.sourceCommit, source) : undefined),
                operation: useRenderer ? 'qualify-components' : 'qualify-all', ...(useRenderer && rendererBaseline.boundary === commerceBoundary ? { kind: 'commerce', reason: 'Fresh paid-order D1 journey and live smoke; every renderer input is identical to the original full qualification.' } : {}), requiredBeforeNativePromotion: true, automaticInPreview: false },
            ...(policyVersion === 3 ? { routineTargetMs: (!needsNative || useRenderer && rendererBaseline.boundary === commerceBoundary) ? 600000 : null } : {}), estimatedMinutes: null, estimateNote: 'No measured estimate for this plan. Use release:measurements; qualification and owner review are separate.' } : { estimatedMinutes: stages.reduce((n, stage) => n + (stage.inputs.operation === 'qualify-all' ? 20 : stage.inputs.operation === 'qualify-components' ? 5 : stage.inputs.operation ? 14 : 6), 0) }),
        next: components.notifications ? 'Publish changed notification templates separately and verify their saved digest in Shopify.' : null };
}
export function verifyComponentBaselines(journal, live) {
    for (const component of ['native', 'web']) {
        const completed = journal.stages.find(stage => stage.status === 'complete' &&
            (component === 'native' ? ['release', 'promote'].includes(stage.inputs.operation) :
                ['deploy.yml', 'web-production.yml'].includes(stage.workflow)));
        const unchanged = isDeepStrictEqual(live[component], journal.selection.baselines[component]);
        const deployedByJournal = completed && live[component]?.runId === completed.runId &&
            live[component]?.source === journal.source;
        if (!(completed ? deployedByJournal : unchanged))
            throw Error(`Release coordinator stopped: ${component} deployment baseline changed; review a new plan before dispatch.`);
    }
}
