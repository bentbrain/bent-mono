import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { validateAutomatedAcceptance, routineAuthorization } from './automated-release-acceptance.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { validatePromotionManifest, promotionManifest } from './release-manifest.mjs';
const check = (value, reason) => {
    if (!value)
        throw Error(`Promotion input rejected: ${reason}`);
};
// This is a release request, not admission. Actions authenticates the referenced
// runs and immutable objects, then seals these exact bytes before app mutations.
export function parsePromotionInput(text, source) {
    check(typeof text === 'string' && Buffer.byteLength(text) <= 24576, 'bounded release request');
    const value = JSON.parse(text);
    check([1, 2].includes(value?.schemaVersion) && /^[a-f0-9]{40}$/.test(source ?? '') && value.sourceCommit === source, 'exact release source');
    const acceptanceField = value.schemaVersion === 2 ? 'acceptance' : 'phone';
    check(equal(Object.keys(value).sort(), [acceptanceField, 'candidateReceipt', 'manifest', 'qualification', 'schemaVersion', 'sourceCommit'].sort()), 'exact input fields');
    const manifest = validatePromotionManifest(value.manifest), q = value.qualification, phone = value.phone, candidate = value.candidateReceipt;
    check(q?.schemaVersion === 1 && q.expectedPair?.sourceCommit === source && q.expectedQualificationCommit === source &&
        q.qualificationRunId === manifest.qualification.runId && q.expectedPair.releaseId === manifest.qualification.releaseId &&
        q.expectedPair.imageDigest === manifest.candidate.imageDigest && manifest.qualification.sourceCommit === source, 'one qualified source and pair');
    check(q.reference?.key === "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-receipt-" + (q.expectedPair.releaseId) + "-run-" + (q.qualificationRunId) + ".json" &&
        /^[a-f0-9]{64}$/.test(q.reference.sha256 ?? '') && /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(q.reference.version ?? '') && q.reference.version !== 'null', 'immutable completed qualification receipt');
    if (value.schemaVersion === 2)
        validateAutomatedAcceptance(value.acceptance, q, source);
    else
        check(phone?.schemaVersion === 1 && phone.acceptanceType === 'owner-phone-report' && phone.ownerResponse === manifest.phone.ownerResponse &&
            phone.workerVersionId === manifest.phone.workerVersionId && phone.imageDigest === manifest.candidate.imageDigest &&
            equal(phone.requestedChecks, manifest.phone.requestedChecks) && /^\d{4}-\d{2}-\d{2}$/.test(phone.reportedDate ?? ''), 'actual owner report for later pair verification');
    check(candidate?.schemaVersion === 1 && candidate.sourceDigest === manifest.candidate.sourceDigest &&
        candidate.candidateKey === `source/candidates/${candidate.sourceDigest}/${manifest.candidate.buildRunId}.json` &&
        /^[a-f0-9]{64}$/.test(candidate.candidateSha256 ?? '') && /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(candidate.candidateVersion ?? '') &&
        candidate.candidateVersion !== 'null', 'immutable image candidate receipt');
    // Alert delivery is infrastructure evidence, independent of this source. Keep
    // the reviewed report and allowlist; the capsule cannot replace or forge it.
    check(equal(manifest.alertDelivery, promotionManifest.alertDelivery), 'existing reviewed alert delivery evidence');
    return value;
}
export function promotionInput(env) {
    return env.NATIVE_PROMOTION_INPUT ? parsePromotionInput(env.NATIVE_PROMOTION_INPUT, env.GITHUB_SHA) : null;
}
export async function sealPromotionInput(input, source, save) {
    const bytes = JSON.stringify(parsePromotionInput(JSON.stringify(input), source));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reference = await save('promotion-input.json', bytes);
    check(reference?.sha256 === sha256 && typeof reference.version === 'string' && reference.version !== 'null', 'immutable input acknowledgement');
    return reference;
}
if (import.meta.main) {
    const { parseArgs } = await import('node:util'), { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process'), { dirname, resolve } = await import('node:path');
    const { values } = parseArgs({ options: { qualification: { type: 'string' }, phone: { type: 'string' }, 'preview-run': { type: 'string' }, candidate: { type: 'string' }, 'candidate-manifest': { type: 'string' }, output: { type: 'string' } } });
    check(values.qualification && Boolean(values.phone) !== Boolean(values['preview-run']) && values.output, 'supply --qualification, exactly one of --phone or --preview-run, and --output');
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const load = async (path) => JSON.parse(resolveProtectedTemplate(await readFile(path, 'utf8')));
    const qualification = await load(values.qualification), phone = values.phone ? await load(values.phone) : null, candidateReceipt = await load(values.candidate ?? 'infra/story-video-lambda/development-candidate.json');
    const buildRunId = Number(/\/([1-9][0-9]*)\.json$/.exec(candidateReceipt.candidateKey ?? '')?.[1]);
    // An explicit reviewed tuple can select a newer immutable build. Never infer
    // that build's source from the application or qualification source.
    const reviewedCandidate = values['candidate-manifest'] ? await load(values['candidate-manifest']) : promotionManifest.candidate;
    check(equal(Object.keys(reviewedCandidate ?? {}).sort(), ['buildRunId', 'imageDigest', 'sourceCommit', 'sourceDigest']), 'exact reviewed image candidate fields');
    validatePromotionManifest({ ...promotionManifest, candidate: reviewedCandidate });
    check(buildRunId === reviewedCandidate.buildRunId && candidateReceipt.sourceDigest === reviewedCandidate.sourceDigest, 'reviewed image candidate');
    const manifest = { ...promotionManifest, candidate: reviewedCandidate, qualification: { releaseId: qualification.expectedPair?.releaseId, runId: qualification.qualificationRunId, sourceCommit },
        phone: phone ? { ...promotionManifest.phone, ownerResponse: phone.ownerResponse, workerVersionId: phone.workerVersionId, requestedChecks: phone.requestedChecks } : promotionManifest.phone };
    const acceptance = { schemaVersion: 1, acceptanceType: 'automated-cloud-and-browser', authorization: routineAuthorization, sourceCommit,
        developmentReleaseId: qualification.expectedPair?.releaseId, imageDigest: qualification.expectedPair?.imageDigest,
        qualificationRunId: qualification.qualificationRunId, previewRunId: Number(values['preview-run']) };
    const input = { schemaVersion: phone ? 1 : 2, sourceCommit, candidateReceipt, manifest, qualification, ...(phone ? { phone } : { acceptance }) };
    parsePromotionInput(JSON.stringify(input), sourceCommit);
    const path = resolve(values.output);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(input, null, 2), { flag: 'wx', mode: 0o600 });
    console.info(`Promotion request saved for review: ${path}. No release was dispatched.`);
}
