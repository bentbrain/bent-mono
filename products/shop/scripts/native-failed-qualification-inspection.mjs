import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { protectedConfig } from './protected-config.mjs';
import { createDevelopmentCICall } from './native-ci-aws.mjs';
import { developmentCloudflare } from './native-ci-cloudflare.mjs';
import { developmentOperation } from './native-ci-operation.mjs';
import { loadDevelopmentPreparation } from './native-development-preparation.mjs';
import { failedInventoryInspectionDescriptor, readQualificationRun } from './native-qualification-reference.mjs';
import { validateQualificationInventory, assertQualificationCleanupFence } from './native-qualification-inventory.mjs';
import { verifyWorkerUpload } from './native-worker-content.mjs';
import { sealReleaseEvidence } from './release-evidence.mjs';
const check = (value, reason) => { if (!value) throw Error(`Failed qualification inspection stopped: ${reason}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const version = value => typeof value === 'string' && /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(value) && value !== 'null';
const rows = async (cf, sql, params = []) => (await cf.query(sql, params))[0].results;
// Only these consumers' fixed SELECTs reach the provider. Methods for pause,
// claims, resource mutation, lifecycle changes and cleanup are never exposed.
export function failedInspectionQueries(cf, releaseId) {
    return Object.freeze({ query: async (sql, params = []) => {
        const direct = [
            "SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'prepared'",
            "SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'verified'",
        ];
        const control = 'SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1';
        const fence = `SELECT CASE WHEN EXISTS (SELECT 1 FROM native_video_release_control
  WHERE singleton = 1 AND paused = 0 AND release_id IS NULL AND current_release_id = ?)
  AND EXISTS (SELECT 1 FROM native_video_release_events WHERE release_id = ? AND stage = 'verified' AND payload = ?) THEN 1 ELSE 0 END AS allowed`;
        check(direct.includes(sql) && equal(params, [releaseId]) || sql === control && params.length === 0 ||
            sql === fence && params.length === 3 && params[0] === releaseId && params[1] === releaseId && typeof params[2] === 'string', 'fixed read-only journal query');
        return cf.query(sql, params);
    } });
}
export async function inspectRetainedFailedQualification(env = process.env, dependencies = {}) {
    check(developmentOperation(env) === 'inspect-failed-qualification', 'dedicated first-attempt main inspection operation');
    const descriptor = failedInventoryInspectionDescriptor(env.NATIVE_QUALIFICATION_REFERENCE, env.NATIVE_VERIFY_RELEASE);
    check(String(descriptor.qualificationRunId) !== env.GITHUB_RUN_ID && env.RUNNER_TEMP?.startsWith('/'), 'distinct inspection run and private runner directory');
    const request = dependencies.request ?? fetch;
    const github = async path => {
        check(env.GITHUB_TOKEN, 'authenticated canonical workflow read');
        const response = await request(`https://api.github.com/repos/bentbrain/bent-mono/${path}`, {
            headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
            redirect: 'error', signal: AbortSignal.timeout(30000),
        });
        check(response.ok, 'canonical workflow response');
        return response.json();
    };
    // Authenticate the original run before selecting any provider object.
    const run = await readQualificationRun(env, descriptor.qualificationRunId, request);
    const workflow = await github('actions/workflows/native-development.yml');
    check(Number.isSafeInteger(workflow.id) && workflow.id > 0 && workflow.path === '.github/workflows/native-development.yml' &&
        workflow.state === 'active' && run.workflow_id === workflow.id && run.conclusion === 'failure' && run.head_sha === descriptor.sourceCommit &&
        new RegExp(`^Native development · (?:qualify-all|qualify-components) · full · ${descriptor.releaseId} · - · main · ${descriptor.sourceCommit} · \\[[^\\]\\r\\n]+\\]$`).test(run.display_title ?? ''), 'authenticated original canonical failed full qualification');
    check((await github('git/ref/heads/main')).object?.sha === env.GITHUB_SHA, 'inspection requires current exact main');
    const started = Date.parse(run.run_started_at), completed = Date.parse(run.updated_at);
    check(Number.isFinite(started) && Number.isFinite(completed) && completed >= started, 'original first-attempt time bounds');
    const call = await (dependencies.createCall ?? createDevelopmentCICall)(env);
    const cf = failedInspectionQueries(dependencies.cf ?? developmentCloudflare(env), descriptor.releaseId);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, 'failed-inventory-inspection-'));
    const bucket = ['--bucket', `forever-tee-video-development-${protectedConfig('awsAccountId')}-ap-southeast-2`, '--expected-bucket-owner', protectedConfig('awsAccountId')];
    let sequence = 0;
    const readExact = async (key, bound, expected) => {
        const head = async () => call(['s3api', 'head-object', ...bucket, '--key', key]);
        const before = await head();
        check(version(before.VersionId) && Number.isSafeInteger(before.ContentLength) && before.ContentLength > 0 && before.ContentLength <= bound &&
            before.DeleteMarker !== true && before.ServerSideEncryption === 'AES256' && typeof before.ETag === 'string' &&
            Number.isFinite(Date.parse(before.LastModified)), 'bounded encrypted immutable original object');
        if (!expected) check(Date.parse(before.LastModified) >= started && Date.parse(before.LastModified) <= completed, 'inventory object is newer than the original failed qualification');
        else check(before.VersionId === expected.version && /^[a-f0-9]{64}$/.test(expected.sha256), 'recorded preparation version');
        const read = async () => {
            const file = join(directory, `original-${sequence++}`);
            const response = await call(['s3api', 'get-object', ...bucket, '--key', key, '--version-id', before.VersionId, '--range', `bytes=0-${bound - 1}`, file]);
            const bytes = await readFile(file);
            check(response.VersionId === before.VersionId && response.ETag === before.ETag && response.ContentLength === before.ContentLength &&
                bytes.length === before.ContentLength && (!expected || hash(bytes) === expected.sha256), 'exact original object bytes and version');
            return bytes;
        };
        const bytes = await read();
        check(equal(await head(), before) && equal(await read(), bytes) && equal(await head(), before), 'stable original HEAD and byte readback');
        return { bytes, reference: { key, version: before.VersionId, sha256: hash(bytes) } };
    };
    const original = await readExact(descriptor.key, 131072);
    const originalEnv = { ...env, GITHUB_RUN_ID: String(run.id), GITHUB_SHA: run.head_sha };
    const inventory = validateQualificationInventory(JSON.parse(original.bytes), originalEnv);
    check(inventory.fixtures.length > 0, 'retained original inventory contains no fixtures');
    const store = Object.freeze({ read: async ref => {
        check(ref?.key === `source/releases/${descriptor.releaseId}/prepared.json` && version(ref.version), 'exact recorded release preparation key');
        return (await readExact(ref.key, 1024 * 1024, ref)).bytes;
    } });
    const prepared = await loadDevelopmentPreparation(cf, store, descriptor.releaseId);
    check(prepared.releaseId === inventory.releaseId && prepared.sourceCommit === run.head_sha && prepared.environment === 'development' &&
        prepared.accountId === protectedConfig('awsAccountId') && prepared.region === 'ap-southeast-2', 'original inventory and recorded release source');
    const controls = await rows(cf, 'SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1');
    check(controls.length === 1 && controls[0].paused === 0 && controls[0].release_id === null && controls[0].current_release_id === inventory.releaseId, 'original release remains current and unpaused');
    const events = await rows(cf, "SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'verified'", [inventory.releaseId]);
    check(events.length === 1, 'exact original verified pair');
    const verified = JSON.parse(events[0].payload), candidate = prepared.candidate;
    check(verified.releaseId === inventory.releaseId && verified.sourceCommit === inventory.sourceCommit && equal(verified.candidate, candidate) &&
        /^sha256:[a-f0-9]{64}$/.test(candidate?.imageDigest ?? '') && /^[a-f0-9]{64}$/.test(candidate?.sourceDigest ?? '') &&
        verified.runtime?.renderer?.imageDigest === candidate.imageDigest && verified.runtime?.failure?.imageDigest === candidate.imageDigest &&
        verified.runtime?.renderer?.sourceDigest === candidate.sourceDigest &&
        /^[a-f0-9-]{36}$/.test(verified.worker?.workerVersion ?? '') && /^[a-f0-9]{64}$/.test(verified.worker?.versionResourcesSha256 ?? ''), 'recorded Worker and renderer pair');
    verifyWorkerUpload(verified.worker.content, prepared.worker);
    const fence = { releaseId: inventory.releaseId, verifiedPayload: events[0].payload };
    await assertQualificationCleanupFence(cf, fence);
    check(equal(await readExact(descriptor.key, 131072, original.reference), original), 'inventory changed during recorded pair inspection');
    await assertQualificationCleanupFence(cf, fence);
    check((await github('git/ref/heads/main')).object?.sha === env.GITHUB_SHA, 'main changed during inspection');
    const exported = { schemaVersion: 1, inspectionRunId: env.GITHUB_RUN_ID, inspectionSourceCommit: env.GITHUB_SHA,
        originalRun: run, descriptor, inventoryReference: original.reference, inventoryBytesBase64: original.bytes.toString('base64'),
        pair: { releaseId: inventory.releaseId, sourceCommit: inventory.sourceCommit, imageDigest: candidate.imageDigest, workerVersion: verified.worker.workerVersion },
        fence, qualificationComplete: false, cleanupApproved: false, productionApproved: false, providerWrites: 0 };
    await writeFile(join(env.RUNNER_TEMP, 'qualification-inventory-export.json'), sealReleaseEvidence(exported,
        { sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, filename: 'qualification-inventory-export.json' }, env), { flag: 'wx', mode: 0o600 });
    return { inspected: true, originalRunId: run.id, qualificationComplete: false, cleanupApproved: false, productionApproved: false, providerWrites: 0 };
}
