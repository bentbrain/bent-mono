import { protectedConfig } from "./protected-config.mjs";
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const check = (ok, reason) => { if (!ok)
    throw Error(`Paid-order recovery stopped: ${reason}`); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const target = { orderId: protectedConfig("resource_5df53ebae4ae"), productId: protectedConfig("resource_211886fbc19e"),
    providerProductId: protectedConfig("order1003ProviderProductId"), requestSha256: protectedConfig("resource_1b4cc40f0983") };
const sha256 = /^[a-f0-9]{64}$/;
export function recoveryContext(env) {
    const environment = env.OPERATIONS_ENVIRONMENT;
    check(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' &&
        env.GITHUB_REPOSITORY === 'bentbrain/bent-mono' && env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") &&
        env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") && env.GITHUB_ACTOR_ID === protectedConfig("githubOwnerId") &&
        env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
        env.GITHUB_RUN_ATTEMPT === '1' && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
        env.GITHUB_WORKFLOW_REF === 'bentbrain/bent-mono/.github/workflows/paid-order-product-recovery.yml@refs/heads/main', 'exact first-attempt owner workflow required.');
    check(environment === 'production' &&
        env.WORKER_URL === 'https://forever-tee-api.socialqueue.workers.dev', 'exact environment and personal Worker required.');
    check(['plan', 'apply'].includes(env.OPERATION) && uuid.test(env.PAID_ORDER_ID ?? '') && env.PAID_ORDER_ID === target.orderId &&
        /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && env.BENT_SHIRT_OPERATIONS_SECRET &&
        env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && env.ACTIONS_ID_TOKEN_REQUEST_URL, 'bounded operation and authentication required.');
    if (env.OPERATION === 'apply')
        check(sha256.test(env.EXPECTED_PLAN_SHA256 ?? ''), 'reviewed plan hash required.');
    const body = JSON.stringify({ operation: env.OPERATION, orderId: env.PAID_ORDER_ID, expectedSource: env.GITHUB_SHA,
        ...(env.OPERATION === 'apply' ? { expectedPlanSha256: env.EXPECTED_PLAN_SHA256 } : {}) });
    return { environment, body, url: new URL('/v2/internal/operations/paid-order-product-recovery', env.WORKER_URL) };
}
export async function runRecovery(env = process.env, request = fetch, save = writeFile) {
    const { environment, body, url } = recoveryContext(env);
    // Persist intent once. A lost response stops; inspect the order before
    // deciding anything further. Never automatically replay an apply request.
    await save('order-product-recovery-request.json', body, { flag: 'wx', mode: 0o600 });
    const digest = createHash('sha256').update(body).digest('hex');
    const audience = `bent-shirt:operations:${environment}:POST:${url.pathname}:${digest}`;
    const identityUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    check(identityUrl.protocol === 'https:' && identityUrl.hostname.endsWith('.actions.githubusercontent.com'), 'GitHub identity endpoint required.');
    identityUrl.searchParams.set('audience', audience);
    const identityResponse = await request(identityUrl, { redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    check(identityResponse.ok, 'workflow identity unavailable.');
    const identity = await identityResponse.json();
    check(typeof identity?.value === 'string' && identity.value.length > 0, 'workflow identity missing.');
    const response = await request(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${identity.value}`, 'content-type': 'application/json',
            'x-bent-shirt-operations-secret': env.BENT_SHIRT_OPERATIONS_SECRET } });
    check(response.ok, `Worker rejected recovery with HTTP ${response.status}; inspect the existing order, do not replay.`);
    const result = await response.json();
    check(result?.productId === target.productId && result.providerProductId === target.providerProductId &&
        result.requestSha256 === target.requestSha256 && result?.ready === true && result.orderId === env.PAID_ORDER_ID && result.orderName === '#1003' &&
        sha256.test(result.planSha256 ?? '') && result.providerMutations === false &&
        result.orderMutations === (env.OPERATION === 'apply') && result.sourceCommit === env.GITHUB_SHA &&
        /^native-[1-9][0-9]*$/.test(result.releaseId ?? '') && result.runId === env.GITHUB_RUN_ID, 'safe response contract differs; inspect the order, do not replay.');
    if (env.OPERATION === 'apply')
        check(result.planSha256 === env.EXPECTED_PLAN_SHA256 && result.normalVerificationRequired === true, 'apply receipt differs; inspect the order, do not replay.');
    const safe = { productId: result.productId, providerProductId: result.providerProductId, requestSha256: result.requestSha256, ready: true, orderId: result.orderId, orderName: result.orderName, planSha256: result.planSha256,
        providerMutations: false, orderMutations: result.orderMutations, sourceCommit: result.sourceCommit,
        releaseId: result.releaseId, runId: result.runId,
        ...(env.OPERATION === 'apply' ? { normalVerificationRequired: true } : {}) };
    await save('order-product-recovery-result.json', JSON.stringify(safe), { flag: 'wx', mode: 0o600 });
    return safe;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await runRecovery()));
    }
    catch (error) {
        console.error(error instanceof Error && error.message.startsWith('Paid-order recovery stopped:')
            ? error.message : 'Paid-order recovery failed; inspect saved intent and order state before another operation.');
        process.exitCode = 1;
    }
}
