import { protectedConfig } from "./protected-config.mjs";
const check = (value, reason) => {
    if (!value)
        throw Error(`Qualification recovery stopped: ${reason}`);
};
export function recoveryReference(value, releaseId) {
    check(typeof value === 'string' && value.length <= 4096, 'bounded immutable reference required');
    const reference = JSON.parse(value);
    const match = new RegExp("^source\\/releases\\/native-" + protectedConfig("resource_8d0190ecec7d") + "\\/qualification-complete-summary-(native-[1-9][0-9]*)-run-([1-9][0-9]*)\\.json$", "").exec(reference.key ?? '');
    check(match && match[1] === releaseId && /^[a-f0-9]{64}$/.test(reference.sha256 ?? '') &&
        typeof reference.version === 'string' && /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(reference.version) && reference.version !== 'null', 'original functional summary reference');
    const runId = Number(match[2]);
    check(Number.isSafeInteger(runId), 'original run ID');
    return { reference, runId };
}
export async function readQualificationRun(env, runId, request = fetch) {
    check(Number.isSafeInteger(runId) && runId > 0 && env.GITHUB_TOKEN, 'authenticated personal run read');
    const response = await request(`https://api.github.com/repos/bentbrain/bent-mono/actions/runs/${runId}`, {
        redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    check(response.ok, 'original run response');
    const run = await response.json();
    check(run.id === runId && run.repository?.id === Number(protectedConfig("githubRepositoryId")) && run.repository?.owner?.id === Number(protectedConfig("githubOwnerId")) &&
        run.head_repository?.id === Number(protectedConfig("githubRepositoryId")) && run.path === '.github/workflows/native-development.yml' &&
        run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.run_attempt === 1 && run.status === 'completed', 'original first-attempt personal main workflow');
    return run;
}
export function rendererReference(value) {
    check(typeof value === 'string' && value.length <= 4096, 'bounded original receipt reference');
    const reference = JSON.parse(value);
    const match = new RegExp("^source\\/releases\\/native-" + protectedConfig("resource_8d0190ecec7d") + "\\/qualification-receipt-(native-[1-9][0-9]*)-run-([1-9][0-9]*)\\.json$", "").exec(reference.key ?? '');
    check(match && typeof reference.version === 'string' && reference.version !== 'null' && reference.version.length <= 1024 &&
        /^[a-f0-9]{64}$/.test(reference.sha256 ?? ''), 'immutable original receipt');
    const runId = Number(match[2]);
    check(Number.isSafeInteger(runId), 'qualification run ID');
    return { reference, releaseId: match[1], runId };
}
export function failedQualificationReference(value, releaseId) {
    check(typeof value === 'string' && value.length <= 4096, 'bounded failed inventory reference required');
    const reference = JSON.parse(value);
    const match = new RegExp("^source\\/releases\\/native-" + protectedConfig("resource_8d0190ecec7d") + "\\/qualification-cleanup-inventory-(native-[1-9][0-9]*)-run-([1-9][0-9]*)\\.json$", "").exec(reference.key ?? '');
    check(match && match[1] === releaseId && /^[a-f0-9]{64}$/.test(reference.sha256 ?? '') &&
        typeof reference.version === 'string' && /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(reference.version) && reference.version !== 'null', 'original failed cleanup inventory reference');
    const runId = Number(match[2]);
    check(Number.isSafeInteger(runId), 'original failed run ID');
    return { reference, runId };
}
export function failedInventoryInspectionDescriptor(value, releaseId) {
    check(typeof value === 'string' && value.length <= 4096, 'bounded failed inventory inspection descriptor');
    const descriptor = JSON.parse(value);
    check(descriptor && Object.keys(descriptor).sort().join() === 'key,qualificationRunId,releaseId,schemaVersion,sourceCommit' &&
        descriptor.schemaVersion === 1 && Number.isSafeInteger(descriptor.qualificationRunId) && descriptor.qualificationRunId > 0 &&
        descriptor.releaseId === releaseId && /^native-[1-9][0-9]*$/.test(releaseId ?? '') &&
        /^[a-f0-9]{40}$/.test(descriptor.sourceCommit ?? ''), 'exact original failed run, release and source descriptor');
    const expected = `source/releases/native-${protectedConfig('resource_8d0190ecec7d')}/qualification-cleanup-inventory-${releaseId}-run-${descriptor.qualificationRunId}.json`;
    check(descriptor.key === expected, 'derived original failed inventory key');
    return descriptor;
}
