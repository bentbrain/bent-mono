import { sealReleaseEvidence } from "./release-evidence.mjs";
import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAutomatedAcceptance, verifyAutomatedBrowserEvidence, readAutomatedBrowserEvidence, autonomousAuthorization } from './automated-release-acceptance.mjs';
import { writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const source = 'a'.repeat(40), image = `sha256:${'b'.repeat(64)}`;
function fixture() {
    const acceptance = { schemaVersion: 1, acceptanceType: 'automated-cloud-and-browser', authorization: autonomousAuthorization,
        sourceCommit: source, developmentReleaseId: 'native-100', imageDigest: image, qualificationRunId: 200, previewRunId: 300 };
    const qualification = { cloudQualificationVerified: true, qualificationKind: 'full', sourceCommit: source,
        qualificationSourceCommit: source, releaseId: 'native-100', imageDigest: image, qualificationRunId: 200 };
    const run = { id: 300, status: 'completed', conclusion: 'success', run_attempt: 1, event: 'workflow_dispatch',
        head_branch: 'main', head_sha: source, path: '.github/workflows/preview-smoke.yml',
        repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) } };
    const before = { schemaVersion: 1, source, baselines: { native: { source, runId: 100 }, web: { source } } };
    return { acceptance, qualification, run, before, after: structuredClone(before) };
}
test('automated acceptance requires a separate successful browser run and a fully qualified unchanged Preview pair', () => {
    const f = fixture();
    validateAutomatedAcceptance(f.acceptance, { expectedPair: { releaseId: 'native-100', imageDigest: image }, qualificationRunId: 200 }, source);
    assert.deepEqual(verifyAutomatedBrowserEvidence(f.acceptance, f.qualification, f.run, f.before, f.after), { acceptanceVerified: true, acceptanceType: 'automated-cloud-and-browser', phoneAcceptanceVerified: false });
    for (const mutate of [
        f => f.qualification.qualificationKind = 'shipping', f => f.qualification.cloudQualificationVerified = false,
        f => f.qualification.qualificationSourceCommit = 'c'.repeat(40), f => f.qualification.imageDigest = 'other',
        f => f.qualification.qualificationRunId++, f => f.run.conclusion = 'failure', f => f.run.run_attempt = 2,
        f => f.run.head_sha = 'c'.repeat(40), f => f.run.repository.owner.id = 1,
        f => f.run.path = '.github/workflows/deploy.yml', f => f.before.baselines.native.runId++,
        f => f.after.baselines.web.source = 'c'.repeat(40), f => f.after.source = 'c'.repeat(40),
    ]) {
        const copy = fixture();
        mutate(copy);
        assert.throws(() => verifyAutomatedBrowserEvidence(copy.acceptance, copy.qualification, copy.run, copy.before, copy.after));
    }
    for (const mutate of [f => f.authorization = 'invented', f => f.ownerResponse = 'dev looks good',
        f => f.previewRunId = 200, f => f.sourceCommit = 'c'.repeat(40)]) {
        const copy = fixture().acceptance;
        mutate(copy);
        assert.throws(() => validateAutomatedAcceptance(copy, { expectedPair: { releaseId: 'native-100', imageDigest: image }, qualificationRunId: 200 }, source));
    }
});
test('browser evidence is read from its original run artifact and rejects substituted files', async () => {
    const env = { GITHUB_SHA: source, GITHUB_ACTIONS: 'true', RUNNER_TEMP: tmpdir(), GITHUB_TOKEN: 'test-token' };
    const f = fixture();
    const download = async (command, args, options) => {
        assert.equal(command, 'gh');
        assert.equal(args[2], '300');
        assert.equal(args[6], 'preview-browser-evidence-300');
        assert.equal(options.env.GH_TOKEN, 'test-token');
        await writeFile(join(args.at(-1), 'preview-smoke-before.json'), sealReleaseEvidence(f.before,{sourceCommit:source,runId:300,filename:'preview-smoke-before.json'}));
        await writeFile(join(args.at(-1), 'preview-smoke-after.json'), sealReleaseEvidence(f.after,{sourceCommit:source,runId:300,filename:'preview-smoke-after.json'}));
    };
    assert.deepEqual(await readAutomatedBrowserEvidence(env, 300, download), [f.before, f.after]);
    await assert.rejects(readAutomatedBrowserEvidence({ ...env, GITHUB_ACTIONS: 'false' }, 300, download));
    await assert.rejects(readAutomatedBrowserEvidence(env, 300, async (_command, args) => {
        await symlink('/dev/null', join(args.at(-1), 'preview-smoke-before.json'));
    }), /bounded original browser observations/);
});
test('fresh commerce and original renderer evidence support the owner-authorized backend route', () => {
    const f = fixture();
    f.acceptance.authorization = 'owner-2026-10-11-automated-backend-repair';
    validateAutomatedAcceptance(f.acceptance, { expectedPair: { releaseId: 'native-100', imageDigest: image }, qualificationRunId: 200 }, source);
    Object.assign(f.qualification, { qualificationKind: 'commerce', cleanupVerified: true, paidOrderJourneyVerified: true,
        rendererQualification: { boundary: 'isolated-printify-contracts-v2' } });
    assert.equal(verifyAutomatedBrowserEvidence(f.acceptance, f.qualification, f.run, f.before, f.after).acceptanceVerified, true);
    for (const field of ['cleanupVerified', 'paidOrderJourneyVerified']) {
        assert.throws(() => verifyAutomatedBrowserEvidence(f.acceptance, { ...f.qualification, [field]: false }, f.run, f.before, f.after));
    }
});
