import { protectedConfig } from "./protected-config.mjs";
import { qualificationPolicy } from './release-qualification-policy.mjs';
import { applicationContractPath } from "./contract-consumers.mjs";
import { shippingOnlyPaths, commerceOnlyPaths, commerceBoundary, renderingInputManifest, rendererQualificationReusable } from './rendering-inputs.mjs';
import { gitChanges } from './deployment-plan.mjs';
import { apiOnlyPaths } from './native-api-image.mjs';
import { isDeepStrictEqual } from 'node:util';
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
// Environment deployments, not the current main SHA, establish each component's
// predecessor. Unknown operations and failed/incomplete deployments cannot prove
// that an older successful source is still deployed.
export async function componentBaselines({ api, target }) {
    if (!['preview', 'production'].includes(target))
        throw Error('Choose preview or production.');
    const environment = target === 'production' ? 'Production' : 'Preview';
    const baseline = { web: null, native: null };
    const seen = new Set();
    const deployments = await api(`deployments?environment=${environment}&per_page=100`);
    if (!Array.isArray(deployments))
        return baseline;
    for (const deployment of [...deployments].sort((a, b) => b.id - a.id)) {
        if (deployment.environment !== environment)
            continue;
        const statuses = await api(`deployments/${deployment.id}/statuses?per_page=1`);
        const status = statuses[0];
        const id = /^https:\/\/github.com\/bentbrain\/bent-mono\/actions\/runs\/(\d+)(?:\/|$)/.exec(status?.log_url ?? '')?.[1];
        if (!id)
            break;
        const run = await api(`actions/runs/${id}`);
        if (run.id !== Number(id) || run.repository?.id !== Number(protectedConfig("githubRepositoryId")) || run.repository?.owner?.id !== Number(protectedConfig("githubOwnerId")) || run.head_repository?.id !== Number(protectedConfig("githubRepositoryId")) ||
            run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.head_sha !== deployment.sha || !/^[a-f0-9]{40}$/.test(run.head_sha))
            break;
        let components;
        if (run.path === `.github/workflows/native-${target === 'production' ? 'production' : 'development'}.yml`) {
            const operation = /^Native (?:development|production) · ([a-z-]+) ·/.exec(run.display_title ?? '')?.[1];
            if (['plan', 'verify-qualification', 'qualify', 'qualify-all', 'qualify-exhaustion', 'qualify-faults', 'qualify-termination', 'qualify-load', 'monitor', 'inspect-release', 'verify-candidate', 'inspect-image-plan', 'canary', 'cleanup-qualification', 'cleanup-failed-qualification', 'inspect-failed-qualification', 'qualify-components'].includes(operation))
                continue;
            if (!['release', 'promote'].includes(operation))
                break;
            components = ['native'];
        }
        else if (run.path === '.github/workflows/web-production.yml' && target === 'production')
            components = ['web'];
        else if (run.path === '.github/workflows/preview-smoke.yml' && target === 'preview')
            continue;
        else if (run.path === '.github/workflows/deploy.yml' && target === 'preview' &&
            /^Storefront · development · preview=true ·/.test(run.display_title ?? ''))
            components = ['web'];
        else
            break;
        for (const component of components) {
            if (seen.has(component))
                continue;
            seen.add(component);
            if (status?.state === 'success' && run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1)
                baseline[component] = { source: run.head_sha, runId: run.id, deploymentId: deployment.id };
        }
        if (seen.size === 2)
            break;
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
