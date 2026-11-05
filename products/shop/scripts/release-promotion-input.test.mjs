import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePromotionInput, sealPromotionInput } from './release-promotion-input.mjs';
import { promotionManifest } from './release-manifest.mjs';
import { createCoordinator } from './release-coordinator.mjs';
import { autonomousAuthorization } from './automated-release-acceptance.mjs';
const load = path => JSON.parse(resolveProtectedTemplate(readFileSync(new URL(`../${path}`, import.meta.url))));
function fixture() {
    const manifest = structuredClone(promotionManifest), source = manifest.qualification.sourceCommit;
    const qualification = load('infra/story-video-lambda/development-qualification.json');
    qualification.expectedQualificationCommit = source;
    qualification.reference = { key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-receipt-" + (qualification.expectedPair.releaseId) + "-run-" + (qualification.qualificationRunId) + ".json", version: 'immutable', sha256: 'd'.repeat(64) };
    // Development can advance while Production still uses its reviewed image.
    // Keep this parser fixture bound to that manifest, not the latest build receipt.
    const candidateReceipt = { schemaVersion: 1, sourceDigest: manifest.candidate.sourceDigest,
        candidateKey: `source/candidates/${manifest.candidate.sourceDigest}/${manifest.candidate.buildRunId}.json`,
        candidateVersion: 'immutable', candidateSha256: 'c'.repeat(64) };
    return { schemaVersion: 1, sourceCommit: source, manifest, qualification, phone: load(manifest.phone.path), candidateReceipt };
}
test('a reviewed input binds image, qualification and owner report without editing application source', async () => {
    const value = fixture(), text = JSON.stringify(value);
    assert.deepEqual(parsePromotionInput(text, value.sourceCommit), value);
    const journal = createCoordinator({ source: value.sourceCommit, target: 'production', promotion: value });
    assert.deepEqual(journal.promotion, value);
    const saved = [];
    const reference = await sealPromotionInput(value, value.sourceCommit, async (name, body) => {
        saved.push({ name, body });
        return { key: 'private', version: 'immutable', sha256: createHash('sha256').update(body).digest('hex') };
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'promotion-input.json');
    assert.equal(reference.version, 'immutable');
});
test('the Production pair uses the validated submitted candidate while retaining explicit historical rollback identities', () => {
    const value = fixture(), sourceDigest = 'e'.repeat(64), imageDigest = `sha256:${'f'.repeat(64)}`;
    Object.assign(value.manifest.candidate, { sourceDigest, imageDigest });
    Object.assign(value.candidateReceipt, { sourceDigest, candidateKey: `source/candidates/${sourceDigest}/${value.manifest.candidate.buildRunId}.json` });
    value.qualification.expectedPair.imageDigest = imageDigest;
    value.phone.imageDigest = imageDigest;
    const code = 'const value = await import("./scripts/native-production-runtime.mjs"); console.log(JSON.stringify({image:value.PRODUCTION_IMAGE_DIGEST,source:value.PRODUCTION_SOURCE_DIGEST,historical:value.HISTORICAL_PRODUCTION_IMAGE_DIGEST}));';
    const env = { ...process.env, NATIVE_PROMOTION_INPUT: JSON.stringify(value), GITHUB_SHA: value.sourceCommit };
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8' }));
    assert.equal(result.image, imageDigest);
    assert.equal(result.source, sourceDigest);
    assert.notEqual(result.image, result.historical);
    const invalid = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...env, GITHUB_SHA: 'b'.repeat(40) }, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, '');
    const configured = JSON.parse(process.env.SHOP_PROTECTED_CONFIG_JSON);
    configured.currentProductionImageDigest = `sha256:${'8'.repeat(64)}`;
    configured.currentProductionSourceDigest = '9'.repeat(64);
    const currentEnv = { ...env, NATIVE_PROMOTION_INPUT: '', SHOP_PROTECTED_CONFIG_JSON: JSON.stringify(configured) };
    const current = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: currentEnv, encoding: 'utf8' }));
    assert.equal(current.image, configured.currentProductionImageDigest);
    assert.equal(current.source, configured.currentProductionSourceDigest);
    delete configured.currentProductionImageDigest;
    const missing = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...currentEnv, SHOP_PROTECTED_CONFIG_JSON: JSON.stringify(configured) }, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, '');
});
test('wrong artifacts, invented report replacements and incomplete immutable writes cannot establish promotion inputs', async () => {
    for (const mutate of [v => v.sourceCommit = 'f'.repeat(40), v => v.qualification.reference.version = 'null', v => v.qualification.expectedPair.imageDigest = 'other',
        v => v.manifest.qualification.runId = 1, v => v.phone.ownerResponse = 'different', v => v.phone.requestedChecks.pop(),
        v => v.candidateReceipt.candidateSha256 = '', v => v.candidateReceipt.sourceDigest = 'f'.repeat(64), v => v.manifest.alertDelivery.runId = 1, v => v.extra = true]) {
        const v = fixture(), source = v.sourceCommit;
        mutate(v);
        assert.throws(() => parsePromotionInput(JSON.stringify(v), source));
    }
    const v = fixture();
    assert.throws(() => createCoordinator({ source: v.sourceCommit, target: 'preview', promotion: v }));
    await assert.rejects(sealPromotionInput(v, v.sourceCommit, async () => ({ version: 'null', sha256: 'd'.repeat(64) })));
    await assert.rejects(sealPromotionInput(v, v.sourceCommit, async () => { throw Error('lost acknowledgement'); }));
});
test('automated promotion input preserves qualification pins without inventing an owner phone report', () => {
    const value = fixture();
    delete value.phone;
    value.schemaVersion = 2;
    value.acceptance = { schemaVersion: 1, acceptanceType: 'automated-cloud-and-browser', authorization: autonomousAuthorization,
        sourceCommit: value.sourceCommit, developmentReleaseId: value.qualification.expectedPair.releaseId,
        imageDigest: value.qualification.expectedPair.imageDigest, qualificationRunId: value.qualification.qualificationRunId, previewRunId: 12345 };
    assert.deepEqual(parsePromotionInput(JSON.stringify(value), value.sourceCommit), value);
    assert.deepEqual(createCoordinator({ source: value.sourceCommit, target: 'production', promotion: value }).promotion, value);
    const mixed = structuredClone(value);
    mixed.phone = fixture().phone;
    assert.throws(() => parsePromotionInput(JSON.stringify(mixed), value.sourceCommit));
    value.acceptance.qualificationRunId++;
    assert.throws(() => parsePromotionInput(JSON.stringify(value), value.sourceCommit));
});
test('CLI requires an explicit reviewed manifest for a new image and rejects mismatched candidate inputs', () => {
    const root = fileURLToPath(new URL('..', import.meta.url)), directory = mkdtempSync(join(tmpdir(), 'promotion-candidate-'));
    try {
        const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        const candidate = { sourceDigest: 'b'.repeat(64), imageDigest: `sha256:${'c'.repeat(64)}`, buildRunId: 123, sourceCommit: 'a'.repeat(40) };
        const receipt = { schemaVersion: 1, sourceDigest: candidate.sourceDigest, candidateKey: `source/candidates/${candidate.sourceDigest}/123.json`,
            candidateVersion: 'immutable', candidateSha256: 'd'.repeat(64) };
        const qualification = { schemaVersion: 1, expectedPair: { releaseId: 'native-321', sourceCommit: source, imageDigest: candidate.imageDigest },
            expectedQualificationCommit: source, qualificationRunId: 322, reference: { key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-receipt-native-321-run-322.json", version: 'immutable', sha256: 'e'.repeat(64) } };
        const save = (name, value) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path; };
        const candidatePath = save('candidate.json', receipt), qualificationPath = save('qualification.json', qualification), reviewPath = save('review.json', candidate);
        const output = join(directory, 'promotion.json');
        const args = ['scripts/release-promotion-input.mjs', '--qualification', qualificationPath, '--candidate', candidatePath, '--preview-run', '323', '--output', output];
        const run = extra => spawnSync(process.execPath, [...args, ...extra], { cwd: root, encoding: 'utf8' });
        const implicit = run([]);
        assert.notEqual(implicit.status, 0);
        assert.match(implicit.stderr, /reviewed image candidate/);
        const explicit = run(['--candidate-manifest', reviewPath]);
        assert.equal(explicit.status, 0, explicit.stderr);
        const value = JSON.parse(resolveProtectedTemplate(readFileSync(output, 'utf8')));
        assert.deepEqual(parsePromotionInput(JSON.stringify(value), source).manifest.candidate, candidate);
        assert.equal(value.schemaVersion, 2);
        assert.equal(Object.hasOwn(value, 'phone'), false);
        rmSync(output);
        for (const change of [{ buildRunId: 124 }, { sourceDigest: 'f'.repeat(64) }, { imageDigest: `sha256:${'f'.repeat(64)}` }, { sourceCommit: 'unreviewed' }, { extra: true }]) {
            save('review.json', { ...candidate, ...change });
            const invalid = run(['--candidate-manifest', reviewPath]);
            assert.notEqual(invalid.status, 0);
            assert.throws(() => readFileSync(output), /ENOENT/);
        }
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
