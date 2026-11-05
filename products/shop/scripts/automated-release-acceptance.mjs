import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { readRegularFile } from './read-regular-file.mjs';
import { join } from 'node:path';
const execute = promisify(execFile);
const check = (condition, reason) => {
    if (!condition)
        throw Error(`Automated acceptance rejected: ${reason}`);
};
export const routineAuthorization = 'owner-2026-10-11-automated-backend-repair';
export const autonomousAuthorization = 'owner-2026-10-05-autonomous-alert-repair';
export function validateAutomatedAcceptance(value, qualification, source) {
    check(value?.schemaVersion === 1 && value.acceptanceType === 'automated-cloud-and-browser' &&
        [autonomousAuthorization, routineAuthorization].includes(value.authorization), 'explicit standing owner authorization');
    check(equal(Object.keys(value).sort(), ['acceptanceType', 'authorization', 'developmentReleaseId', 'imageDigest',
        'previewRunId', 'qualificationRunId', 'schemaVersion', 'sourceCommit']), 'exact acceptance fields');
    check(value.sourceCommit === source && value.developmentReleaseId === qualification.expectedPair?.releaseId &&
        value.imageDigest === qualification.expectedPair?.imageDigest && value.qualificationRunId === qualification.qualificationRunId &&
        Number.isSafeInteger(value.previewRunId) && value.previewRunId > 0 && value.previewRunId !== value.qualificationRunId, 'one qualified source, release and separate browser run');
    return value;
}
export function verifyAutomatedBrowserEvidence(acceptance, qualification, run, before, after) {
    check(qualification.cloudQualificationVerified === true && (qualification.qualificationKind === 'full' || qualification.qualificationKind === 'commerce' &&
        qualification.cleanupVerified === true && qualification.paidOrderJourneyVerified === true &&
        qualification.rendererQualification?.boundary === 'isolated-printify-contracts-v2') &&
        qualification.sourceCommit === acceptance.sourceCommit && qualification.qualificationSourceCommit === acceptance.sourceCommit &&
        qualification.releaseId === acceptance.developmentReleaseId && qualification.imageDigest === acceptance.imageDigest &&
        qualification.qualificationRunId === acceptance.qualificationRunId, 'fresh full cloud qualification and completed cleanup');
    check(run.id === acceptance.previewRunId && run.status === 'completed' && run.conclusion === 'success' &&
        run.run_attempt === 1 && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
        run.head_sha === acceptance.sourceCommit && run.path === '.github/workflows/preview-smoke.yml' &&
        run.repository?.id === Number(protectedConfig("githubRepositoryId")) && run.repository.owner?.id === Number(protectedConfig("githubOwnerId")) && run.head_repository?.id === Number(protectedConfig("githubRepositoryId")), 'successful first-attempt browser workflow at the qualified source');
    check(before?.schemaVersion === 1 && before.source === acceptance.sourceCommit && equal(before, after) &&
        before.baselines?.native?.source === acceptance.sourceCommit &&
        `native-${before.baselines.native.runId}` === acceptance.developmentReleaseId &&
        /^[a-f0-9]{40}$/.test(before.baselines?.web?.source ?? ''), 'browser sources stayed bound to the qualified Preview release');
    return { acceptanceVerified: true, acceptanceType: acceptance.acceptanceType, phoneAcceptanceVerified: false };
}
// Read artifacts from the authenticated original run. Submitted JSON cannot
// replace the browser's before/after observations. Never accept a test retry.
export async function readAutomatedBrowserEvidence(env, runId, run = execute) {
    check(env.GITHUB_ACTIONS === 'true' && env.RUNNER_TEMP?.startsWith('/') && env.GITHUB_TOKEN, 'cloud-only authenticated artifact read');
    const directory = await mkdtemp(join(env.RUNNER_TEMP, 'automated-browser-'));
    try {
        await run('gh', ['run', 'download', String(runId), '--repo', 'bentbrain/bent-mono', '--name', `preview-browser-evidence-${runId}`, '--dir', directory], { env: { PATH: process.env.PATH, GH_TOKEN: env.GITHUB_TOKEN }, timeout: 30000, maxBuffer: 65536 });
        const records = [];
        for (const name of ['before', 'after']) {
            const path = join(directory, `preview-smoke-${name}.json`);
            records.push(JSON.parse(resolveProtectedTemplate(await readRegularFile(path, { minBytes: 1, maxBytes: 16384,
                message: 'Automated acceptance rejected: bounded original browser observations' }))));
        }
        return records;
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
