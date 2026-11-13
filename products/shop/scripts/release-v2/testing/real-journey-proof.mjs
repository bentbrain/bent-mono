import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { canonical, digest, sha256, check, filesUnder, readJSON } from '../data.mjs';
import { subject, allInputs, admit } from '../composition.mjs';
import { readHead } from '../journal.mjs';
import { captureInputs } from '../../../apps/storefront/scripts/proof-inputs.mjs';
import { fixture } from './fixtures.mjs';
import { cli } from './cli.mjs';
import { simulator } from './provider-fixtures.mjs';
import { realJourneyService, retainedEvidence, verifyClosure } from './real-journey-service.mjs';

const { values } = parseArgs({ strict: true, options: { output: { type: 'string' }, capsule: { type: 'string' }, 'prior-proof': { type: 'string' }, 'storage-guard': { type: 'string' } } });
check(values.output && values.capsule && values['prior-proof'] && values['storage-guard'], 'Provide --output, --capsule, --prior-proof and --storage-guard');
check(isAbsolute(values['storage-guard']) && resolve(values['storage-guard']) === values['storage-guard'], 'Provide the trusted absolute storage guard executable');
const checkout = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const output = resolve(values.output), capsule = resolve(values.capsule), prior = resolve(values['prior-proof']);
check(!output.startsWith(`${checkout}/`) && !capsule.startsWith(`${checkout}/`) && !prior.startsWith(`${checkout}/`), 'Private integration paths must remain outside the checkout');
await mkdir(output, { mode: 0o700 });
const startedAt = Date.now(), invocations = [], findings = {};
let provider, service;
try {
  await captureInputs(checkout, output);
  const sourceSubjects = (await readJSON(join(output, 'source-inputs.json'), 16 * 1024 * 1024)).subjects;
  const capsuleManifest = await readJSON(join(capsule, 'capsule-manifest.json'), 16 * 1024 * 1024);
  check(capsuleManifest.awsImageQualified === false && capsuleManifest.runtime.node === process.version && capsuleManifest.runtime.platform === process.platform && capsuleManifest.runtime.arch === process.arch, 'Current local capsule runtime required');
  for (const input of capsuleManifest.sourceInputs) check(sha256(await readFile(join(checkout, input.path))) === input.sha256, `Capsule source input changed: ${input.path}`);
  const execute = promisify(execFile);
  const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
  const baseCommit = (await execute('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: checkout })).stdout.trim();
  const f = await fixture({ root: join(output, 'admission') });
  await rm(f.bundle, { recursive: true }); await mkdir(f.bundle, { mode: 0o700 });
  const extraPaths = [...new Set([...capsuleManifest.sourceInputs.map(input => input.path), ...(await filesUnder(fileURLToPath(new URL('../', import.meta.url)))).map(path => `products/shop/scripts/release-v2/${path}`)])];
  const inputPaths = [...new Set([...sourceSubjects.map(input => input.path), ...extraPaths])].sort();
  const inputs = [];
  for (const path of inputPaths) { const bytes = await readFile(join(checkout, path)); inputs.push({ path, sha256: sha256(bytes) }); await f.put(`snapshots/${commit}/${path}`, bytes); }
  const inputsRef = await f.put('metadata/full-inputs.json', { schema: 'shop.full-inputs/v1', files: inputs });
  const inventory = async root => Promise.all((await filesUnder(root)).map(async path => { const bytes = await readFile(join(root, path)); return { path, sha256: sha256(bytes), bytes: bytes.length }; }));
  const storefrontRoot = join(checkout, 'products/shop/apps/storefront/dist');
  const storefrontFiles = await inventory(storefrontRoot), capsuleFiles = await inventory(capsule);
  const businessBytes = await readFile(join(prior, 'business-worker.mjs'));
  const identity = { schema: 'shop.actual-local-journey-service/v1', scope: 'inactive-local-real-journey', awsImageQualified: false,
    executable: { path: process.execPath, sha256: sha256(await readFile(process.execPath)) },
    storageGuard: values['storage-guard'], storageGuardDigest: sha256(await readFile(values['storage-guard'])), sourceSubjects,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
    lockDigest: inputs.find(input => input.path === 'bun.lock').sha256,
    capsuleManifestDigest: sha256(await readFile(join(capsule, 'capsule-manifest.json'))), businessWorkerDigest: sha256(businessBytes),
    groups: [{ name: 'source', root: checkout, complete: false, files: inputs.map(input => ({ ...input, bytes: undefined })) },
      { name: 'storefront', root: storefrontRoot, complete: true, files: storefrontFiles }, { name: 'native-capsule', root: capsule, complete: true, files: capsuleFiles }] };
  // Every reference includes the actual byte count; undefined cannot enter canonical JSON.
  for (const file of identity.groups[0].files) file.bytes = (await readFile(join(checkout, file.path))).length;
  const sourceTreeDigest = digest(inputs);
  f.trust.intentCommits = [commit]; f.trust.baseCommit = baseCommit; f.trust.inputPaths = inputPaths;
  f.trust.snapshots = [{ commit, root: `snapshots/${commit}`, treeDigest: sourceTreeDigest }];
  const components = [];
  const contract = f.payload.components[0].contract;
  for (const [id, root, files, entry] of [
    ['business', prior, [{ path: 'business-worker.mjs', sha256: sha256(businessBytes), bytes: businessBytes.length }], 'business-worker.mjs'],
    ['native', capsule, capsuleFiles, 'product-image-v5-entry.mjs'],
    ['storefront', storefrontRoot, storefrontFiles, 'server/index.js'],
  ]) {
    const artifactFiles = [];
    for (const file of files) artifactFiles.push({ ...await f.put(`artifacts/${id}/${file.path}`, await readFile(join(root, file.path))), mediaType: 'application/octet-stream' });
    artifactFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const config = await f.put(`metadata/${id}-config.json`, { schema: 'shop.fixture-config/v1', fixture: true, component: id, bindings: [] });
    const provenance = await f.put(`metadata/${id}-provenance.json`, { schema: 'shop.fixture-provenance/v1', component: id, originSourceCommit: commit,
      sourceTreeDigest, inputsDigest: sourceTreeDigest, artifactFilesDigest: digest(artifactFiles), recipeDigest: digest(identity), toolchainDigest: identity.executable.sha256, dependencyLockDigest: identity.lockDigest });
    const artifact = await f.put(`metadata/${id}-artifact.json`, { schema: 'shop.artifact/v1', component: id, format: 'module-bundle', root: `artifacts/${id}`, entrypoint: `artifacts/${id}/${entry}`,
      files: artifactFiles, originSourceCommit: commit, inputsDigest: sourceTreeDigest, configDigest: config.sha256, provenanceDigest: provenance.sha256 });
    components.push({ id, originSourceCommit: commit, sourceTreeDigest, inputsDigest: sourceTreeDigest, intentInputsDigest: sourceTreeDigest, inputsRef, intentInputsRef: inputsRef, artifact, config, provenance, contract });
  }
  provider = await simulator();
  const expected = {}, token = randomUUID(); let failJourney = false;
  service = await realJourneyService({ identity, expected, output: join(output, 'journeys'), checkout, capsule, token, fault: () => failJourney });
  const template = await readFile(new URL('./real-journey-runner.mjs', import.meta.url), 'utf8');
  const runner = await f.put('runner.mjs', template.replace('/* private integration configuration */ null', canonical({ origin: service.origin, token, serviceIdentityDigest: service.serviceIdentityDigest })));
  f.trust.runner = { id: 'j01-built-shop-customer-journey', script: runner, executableDigest: identity.executable.sha256, timeoutMs: 120000,
    origins: [service.origin], requiredObservations: ['j01-built-customer-journey', ...retainedEvidence.map(item => item.id), 'j01-service-execution'] };
  await writeFile(f.trustPath, canonical(f.trust), { mode: 0o600 });
  Object.assign(f.payload, { intentSourceCommit: commit, baseCommit, policyDigest: digest(f.trust), components, dependencies: [], createdAt: new Date().toISOString() });
  f.manifest = await f.seal();
  const admission = await admit({ bundle: f.bundle, manifest: f.manifest, trustPath: f.trustPath });
  Object.assign(expected, { schema: 'shop.fixture-journey-request/v1', journeyId: f.trust.runner.id, compositionDigest: admission.compositionDigest,
    subjectDigest: subject(f.payload), inputsDigest: allInputs(f.payload), intentSourceCommit: commit, baseCommit, origin: provider.origin,
    allowedOrigins: [provider.origin, service.origin], components: components.map(component => ({ component: component.id, artifactDigest: component.artifact.sha256,
      configDigest: component.config.sha256, artifact: component.artifact, config: component.config, provenance: component.provenance,
      originSourceCommit: component.originSourceCommit, inputsDigest: component.inputsDigest, intentInputsDigest: component.intentInputsDigest })) });
  await writeFile(join(output, 'service-identity.private.json'), canonical(identity), { mode: 0o600 });
  await writeFile(join(output, 'integration-inputs.private.json'), canonical({ checkout, capsule, prior, commit, baseCommit, dirtySnapshot: true, trustPath: f.trustPath,
    manifest: f.manifest, bundle: f.bundle, providerOrigin: provider.origin, serviceOrigin: service.origin, compositionDigest: admission.compositionDigest,
    scope: 'inactive-local-real-journey-with-simulated-release-provider', qualificationReceipts: 'synthetic-controller-policy-fixtures', productionQualified: false }), { mode: 0o600 });
  const invoke = async (configuration = f, command = 'advance') => { const result = await cli(configuration, provider.origin, { command, timeoutMs: 135000 }); invocations.push(result); return result; };
  const state = async configuration => (await readHead(configuration.journal))?.state;
  // Corrupted artifact and stale lock snapshots must fail before provider access.
  for (const [name, path] of [['artifactMismatch', join(f.bundle, 'artifacts/business/business-worker.mjs')], ['staleLock', join(f.bundle, `snapshots/${commit}/bun.lock`)]]) {
    const original = await readFile(path), calls = provider.state.calls.length;
    await writeFile(path, Buffer.concat([original, Buffer.from('\nchanged')]));
    try { assert.equal((await invoke()).code, 1); assert.equal(provider.state.calls.length, calls); findings[name] = 'rejected-before-provider-access'; }
    finally { await writeFile(path, original); }
  }
  const badRequest = await fetch(`${service.origin}/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: canonical({ ...expected, compositionDigest: '0'.repeat(64), phase: 'candidate', nonce: randomUUID(), evidenceRoot: '/untrusted' }) });
  assert.equal(badRequest.status, 422); findings.mismatchedServiceRequest = await badRequest.json();
  const failed = { ...f, journal: join(output, 'failed-journey-journal') };
  failJourney = true;
  for (let count = 0; count < 40; count++) { const result = await invoke(failed); if (result.code !== 0) break; }
  const failedState = await state(failed);
  assert.equal(service.executions.size, 1, 'Failed case must reach the real journey service');
  assert.equal(failedState.lastVerified, null); assert.equal(failedState.verification, null); assert.equal(provider.state.active.length, 0);
  findings.failedJourney = { phase: failedState.phase, lastVerified: null, active: [], serviceInvocations: service.executions.size };
  failJourney = false;
  for (let count = 0; count < 50; count++) {
    const current = await state(f); if (current?.phase === 'report-intent') break;
    const result = await invoke(); check(result.code === 0, `Actual controller transition failed: ${result.stderr}`);
    check(!JSON.parse(result.stdout).waiting, 'Unexpected unresolved controller transition');
  }
  assert.equal((await state(f)).phase, 'report-intent');
  const runtimeCalls = provider.state.calls.filter(call => !call.path.startsWith('/reports')).length, journeysBefore = service.executions.size;
  provider.controls.dropAfter = 'reports'; assert.equal((await invoke(f, 'recover-report')).code, 1);
  provider.controls.dropAfter = null;
  provider.controls.httpError = true; provider.controls.errorPath = `/reports/${(await state(f)).report.eventId}`;
  assert.equal((await invoke(f, 'recover-report')).code, 1);
  provider.controls.httpError = false;
  assert.equal((await invoke(f, 'recover-report')).code, 0);
  assert.equal((await state(f)).phase, 'complete');
  assert.equal(provider.state.calls.filter(call => !call.path.startsWith('/reports')).length, runtimeCalls);
  assert.equal(service.executions.size, journeysBefore);
  findings.reportingRecovery = { runtimeCalls: 0, journeyExecutions: 0, reportPosts: provider.state.calls.filter(call => call.method === 'POST' && call.path === '/reports').length };
  await verifyClosure(identity);
  findings.complete = true; findings.compositionDigest = admission.compositionDigest;
  findings.serviceIdentityDigest = service.serviceIdentityDigest; findings.artifacts = components.map(component => ({ id: component.id, artifact: component.artifact }));
  findings.runnerEvidence = (await state(f)).verification;
} catch (error) { findings.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  if (service) await service.close(); if (provider) await provider.close();
  await writeFile(join(output, 'invocations.private.json'), canonical(invocations), { mode: 0o600 });
  if (provider) await writeFile(join(output, 'provider-state.private.json'), canonical(provider.state), { mode: 0o600 });
  const summary = { schema: 'shop.controller-real-journey-integration/v1', scope: 'inactive-local', productionQualified: false, providerSimulated: true, startedAt, finishedAt: Date.now(), findings };
  await writeFile(join(output, 'summary.private.json'), canonical(summary), { mode: 0o600 });
  process.stdout.write(`${canonical(summary)}\n`);
}
