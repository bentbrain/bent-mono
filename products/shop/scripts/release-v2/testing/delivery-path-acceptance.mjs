import { createServer } from 'node:http';
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { implementationDigest } from '../composition.mjs';
import { canonical, check, parseJSON, sha256 } from '../data.mjs';
import { createProtectedPackageFixture } from './bootstrap-fixture.mjs';
import { createCompletedHistoryArtifactFixture, createNativeQualificationArtifactFixture } from './history-intake-fixture.mjs';
import { createWorkflowJourneyFixture, createWorkflowNativeBootstrapFixture, createWorkflowUpdateFixture, prepareExpiredWorkflowReporting, recoverStoppedWorkflowOwner, privateProofDirectory, recordedProcess, retainWorkflowProtocolEvidence } from './workflow-journey-fixture.mjs';

const checkout = fileURLToPath(new URL('../../../../../', import.meta.url));
const entrypoint = join(checkout, 'products/shop/scripts/release-v2/workflow-entrypoint.mjs');
const ci = join(checkout, 'products/shop/scripts/release-v2/workflow-ci.mjs');

// All production configuration, adapters, signing and admission remain in use.
// This preload changes only the HTTPS socket destination and test credentials.
async function transportFixture(fixture, output) {
  await privateProofDirectory(output);
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: fixture.bootstrap.root.credentialBroker.audience,
    repository: fixture.bootstrap.identity.repositoryName, repository_id: String(fixture.bootstrap.identity.repository.repositoryId),
    repository_owner_id: String(fixture.bootstrap.identity.repository.ownerId), sha: fixture.bootstrap.identity.head,
    workflow_ref: fixture.bootstrap.identity.workflowRef, run_id: String(fixture.bootstrap.identity.runId), run_attempt: String(fixture.bootstrap.identity.attempt),
    sub: fixture.bootstrap.root.credentialBroker.subject, nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 3600 };
  const value = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(canonical(claims)).toString('base64url')}.c3ludGhldGlj`;
  const identity = createServer((_, response) => { const bytes = Buffer.from(canonical({ value })); response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes); });
  await new Promise(accept => identity.listen(0, '127.0.0.1', accept));
  const custody = new URL(fixture.service.custodyOrigin), bridge = new URL(fixture.bridge.origin);
  const preload = join(output, 'loopback-transport.cjs');
  const bytes = Buffer.from(`const https = require('node:https'), http = require('node:http');
const { syncBuiltinESMExports } = require('node:module');
const { channel } = require('node:diagnostics_channel');
const { writeFileSync } = require('node:fs');
const metrics = {hashCalls:0,hashBytes:0,hashNs:0,readCalls:0,readBytes:0,readNs:0};
const spans = []; let stage = 'process-start', at = process.hrtime.bigint();
channel('shop.release-v2.cost').subscribe(event => {
  if(event.kind==='hash'){metrics.hashCalls++;metrics.hashBytes+=event.bytes;metrics.hashNs+=event.ns;}
  if(event.kind==='regular-read'){metrics.readCalls++;metrics.readBytes+=event.bytes;metrics.readNs+=event.ns;}
});
channel('shop.release-v2.workflow').subscribe(event=>{const now=process.hrtime.bigint();spans.push({stage,elapsedNs:Number(now-at)});stage=event.step;at=now;});
process.once('exit',()=>{spans.push({stage,elapsedNs:Number(process.hrtime.bigint()-at)});writeFileSync(${JSON.stringify(join(output, 'process-cost-'))}+process.pid+'.private.json',JSON.stringify({schema:'shop.acceptance-process-cost/v1',metrics,spans,timingNesting:'Regular read timing includes its nested hashing; hash and read durations must not be added.'}),{mode:0o600});});
const loopbackAgent = new http.Agent({keepAlive:true,maxSockets:1});
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => {
  const target = new URL(url);
  if(target.origin !== 'https://api.github.com' || (options.method || 'GET') !== 'GET') throw Error('Acceptance fetch denies destination: '+url);
  return originalFetch(${JSON.stringify(fixture.bridge.origin)}, {method:'POST',headers:{authorization:'Bearer synthetic-loopback-controller','content-type':'application/json'},body:JSON.stringify({kind:'quality-json',endpoint:target.pathname+target.search})});
};
https.request = function(options, callback) {
  if (options.hostname === 'qualification.example.invalid') return http.request({ ...options, agent:loopbackAgent, hostname:'127.0.0.1',port:${JSON.stringify(custody.port)},path:'/',rejectUnauthorized:undefined,minVersion:undefined,headers:{...options.headers,authorization:'Bearer synthetic-loopback-controller'} },callback);
  if (options.hostname === 'pip.actions.githubusercontent.com') return http.request({ ...options,agent:loopbackAgent,hostname:'127.0.0.1',port:${identity.address().port},path:'/',rejectUnauthorized:undefined,minVersion:undefined },callback);
  throw Error('Acceptance transport denies network destination: '+options.hostname);
};
syncBuiltinESMExports();\n`);
  await writeFile(preload, bytes, { flag: 'wx', mode: 0o600 });
  const bin = join(output, 'bin'); await mkdir(bin, { mode: 0o700 });
  const gh = join(bin, 'gh'), qualityPaths = [...fixture.bootstrap.quality.documents.keys()];
  await writeFile(gh, `#!${process.execPath}
const http=require('node:http');const endpoint=process.argv.at(-1);const qualityPaths=${JSON.stringify(qualityPaths)};
const body=Buffer.from(JSON.stringify({kind:endpoint.endsWith('/zip')?'download':endpoint!=='/repos/bentbrain/bent-mono'&&qualityPaths.includes(endpoint)?'quality-json':'intake-json',endpoint,maxBytes:4294967296}));
const request=http.request({hostname:'127.0.0.1',port:${JSON.stringify(bridge.port)},path:'/',method:'POST',headers:{authorization:'Bearer synthetic-loopback-controller','content-type':'application/json','content-length':body.length}},response=>{if(response.statusCode!==200){response.pipe(process.stderr);process.exitCode=1;}else response.pipe(process.stdout);});request.on('error',error=>{process.stderr.write(error.message);process.exitCode=1;});request.end(body);
`, { flag: 'wx', mode: 0o700 }); await chmod(gh, 0o700);
  return { preload, bin, sha256: sha256(bytes), close: () => new Promise(accept => identity.close(accept)) };
}

async function preparedInvocation({ fixture, output, command = 'deliver' }) {
  await privateProofDirectory(output);
  const transport = await transportFixture(fixture, join(output, 'transport'));
  const packed = await createProtectedPackageFixture(fixture.bootstrap), runner = join(output, 'runner'); await privateProofDirectory(runner);
  const env = { ...fixture.bootstrap.env, PATH: `${transport.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: runner,
    SHOP_COMPOSITION_INSTALLATION_PACKAGE: canonical(packed.packed), SHOP_COMPOSITION_INSTALLATION_PACKAGE_SHA256: packed.digest,
    SHOP_ARTIFACT_RUN_ID: fixture.intake.request.runId, SHOP_ARTIFACT_RUN_ATTEMPT: fixture.intake.request.runAttempt, SHOP_ARTIFACT_ID: fixture.intake.request.artifactId,
    SHOP_COMPOSITION_COMMAND: command, GH_TOKEN: 'synthetic_loopback_github_token', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pip.actions.githubusercontent.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request' };
  const prepared = await recordedProcess({ output, name: 'actual-prepare', args: [ci, 'prepare'], env, timeoutMs: 30000 });
  check(prepared.exitCode === 0, `Actual prepare failed: ${prepared.stderrText}`);
  const configuration = parseJSON(Buffer.from(prepared.stdoutText)).configuration;
  const invoke = name => recordedProcess({ output, name, args: ['--require', transport.preload, entrypoint, '--configuration', configuration], env, timeoutMs: 120000 });
  return { fixture, transport, env, configuration, prepared, invoke, close: () => transport.close() };
}

function requestCounts(service, from, until) {
  const requests = service.transcript.slice(from.provider, until.provider), custody = service.brokerCalls.slice(from.custody, until.custody), operations = {};
  for (const item of requests) {
    const url = new URL(item.url); let operation;
    if (url.hostname.includes('.s3.')) operation = `${url.pathname.startsWith(`/${service.custodyPolicy.store.prefix}/`) ? 'custody-s3' : 'controller-s3'}.${url.pathname.endsWith('/head.json') ? 'head' : 'event'}.${item.method}`;
    else if (url.pathname.includes('/d1/database/')) operation = 'work.query.READ';
    else if (url.hostname === 'api.github.com') operation = `github.${url.pathname.includes('/statuses') ? 'status' : 'deployment'}.${item.method}`;
    else if (url.hostname.startsWith('lambda.')) operation = `lambda.${url.pathname.includes('/aliases') ? 'alias' : url.pathname.endsWith('/versions') ? 'versions' : url.pathname.endsWith('/code') ? 'upload' : 'function'}.${item.method}`;
    else if (url.hostname === 'api.cloudflare.com') operation = `worker.${url.pathname.endsWith('/deployments') ? 'activation' : url.pathname.endsWith('/content') ? 'content' : 'versions'}.${item.method}`;
    else operation = `${url.hostname}.${item.method}`;
    operations[operation] = (operations[operation] ?? 0) + 1;
  }
  const custodyActions = {}; for (const call of custody) custodyActions[call.action] = (custodyActions[call.action] ?? 0) + 1;
  return { providerRequests: requests.length, custodyCalls: custody.length, operations, custodyActions,
    serialNetworkScenarios: [50, 100].map(roundTripMs => ({ roundTripMs, floorMs: (requests.length + custody.length) * roundTripMs })),
    scenarioAssumptions: 'Awaited provider and controller-to-custody requests each incur at least the selected round trip; excludes TLS setup, service time, source checks, artifact transfer and journeys.' };
}

function withSourceRequests(counts, calls) {
  const byKind = {};
  for (const call of calls) byKind[call.kind] = (byKind[call.kind] ?? 0) + 1;
  return { ...counts, githubSourceRequests: { total: calls.length, byKind },
    allSerialNetworkScenarios: [50, 100].map(roundTripMs => ({ roundTripMs, floorMs: (counts.providerRequests + counts.custodyCalls + calls.length) * roundTripMs })) };
}

async function sessionCost(directory) {
  const names = (await readdir(directory)).filter(name => /^session-cost-[a-f0-9-]{36}\.private\.json$/.test(name));
  check(names.length === 1, 'One retained session measurement required for one actual main process');
  return parseJSON(await readFile(join(directory, names[0])), 65536);
}

export async function runDeliveryPathAcceptance({ output }) {
  await privateProofDirectory(output);
  const startedImplementationDigest = await implementationDigest();
  const cleanup = [], t = { after: callback => cleanup.push(callback) }, fixture = await createWorkflowJourneyFixture(t, { output: join(output, 'release-A'), maximumLifetimeMs: 60000 });
  let initial, update, nativeInvocation, nativeFixture;
  try {
    initial = await preparedInvocation({ fixture, output: join(output, 'actual-A') });
    const negativeResults = [];
    const preparedOptions = parseJSON(await readFile(initial.configuration));
    for (const [name, options, env] of [
      ['wrong-installation-pin', { ...preparedOptions, installationDigest: '0'.repeat(64) }, initial.env],
      ['wrong-source', preparedOptions, { ...initial.env, GITHUB_SHA: '3'.repeat(40), GITHUB_WORKFLOW_SHA: '3'.repeat(40) }]
    ]) {
      const config = join(output, `${name}-configuration.private.json`); await writeFile(config, canonical(options), { flag: 'wx', mode: 0o600 });
      const beforeCalls = fixture.service.transcript.length;
      const rejected = await recordedProcess({ output, name, args: ['--require', initial.transport.preload, entrypoint, '--configuration', config], env, timeoutMs: 30000 });
      check(rejected.exitCode !== 0 && fixture.service.transcript.length === beforeCalls, `${name} reached provider transport`); negativeResults.push({ name, providerCalls: 0, writes: 0 });
    }
    for (const name of ['stale-main', 'stale-review']) {
      const config = join(output, `${name}-configuration.private.json`);
      await writeFile(config, canonical({ ...preparedOptions, directory: join(output, `rejected-${name}`) }), { flag: 'wx', mode: 0o600 });
      fixture.bridge.controls.transform = (request, value) => {
        if (name === 'stale-main' && request.endpoint.endsWith('/git/ref/heads/main')) return { object: { sha: '3'.repeat(40) } };
        if (name === 'stale-review' && request.endpoint.includes('/statuses?')) return value.map(item => ({ ...item, state: 'failure' }));
        return value;
      };
      const beforeCalls = fixture.service.transcript.length;
      try {
        const rejected = await recordedProcess({ output, name, args: ['--require', initial.transport.preload, entrypoint, '--configuration', config], env: initial.env, timeoutMs: 30000 });
        check(rejected.exitCode !== 0 && fixture.service.transcript.length === beforeCalls, `${name} reached provider transport`); negativeResults.push({ name, providerCalls: 0, writes: 0 });
      } finally { fixture.bridge.controls.transform = null; }
    }
    const unadoptedWorker = fixture.service.workers.values().next().value;
    unadoptedWorker.active = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    try {
      const config = join(output, 'unadopted-active-runtime.private.json');
      await writeFile(config, canonical({ ...preparedOptions, directory: join(output, 'rejected-unadopted-runtime') }), { flag: 'wx', mode: 0o600 });
      const beforeProvider = fixture.service.transcript.length, beforeCustody = fixture.service.brokerCalls.length;
      const rejected = await recordedProcess({ output, name: 'unadopted-active-runtime', args: ['--require', initial.transport.preload, entrypoint, '--configuration', config], env: initial.env, timeoutMs: 30000 });
      check(rejected.exitCode !== 0 && fixture.service.transcript.slice(beforeProvider).every(item => item.method === 'GET' || item.url.includes('/d1/database/')) && fixture.service.brokerCalls.slice(beforeCustody).every(item => !['open', 'journal', 'dispatch'].includes(item.action)), 'Unadopted active runtime reached ownership or a provider writer');
      negativeResults.push({ name: 'unadopted-active-runtime', writes: 0, writerAcquisitions: 0 });
    } finally { unadoptedWorker.active = null; }
    const at = () => ({ provider: fixture.service.transcript.length, custody: fixture.service.brokerCalls.length });
    const startA = at(), sourceStartA = fixture.bridge.calls.length;
    const first = await initial.invoke('actual-main-deliver');
    check(first.exitCode === 0, `Actual main initial release failed: ${first.stderrText}`);
    const resultA = parseJSON(Buffer.from(first.stdoutText), 16 * 1024 * 1024); check(resultA.controller.phase === 'complete', 'Initial runtime release did not complete');
    const endA = at(), countsA = withSourceRequests(requestCounts(fixture.service, startA, endA), fixture.bridge.calls.slice(sourceStartA));
    const initialOptions = parseJSON(await readFile(initial.configuration)), costA = await sessionCost(resultA.paths.evidenceDirectory);
    const retainedHistory = await createCompletedHistoryArtifactFixture(t, { verifiedReleaseFile: join(initialOptions.directory, 'verified-release.private.json'),
      result: resultA, identity: fixture.bootstrap.identity, portableFixture: fixture.portable, recipientPrivateKeyFile: fixture.intake.privateKeyFile, workflowId: 333,
      artifactId: 792, jobId: 989, originalDirectory: join(output, 'original-completed-A-history') });
    fixture.archives.add(retainedHistory);
    const before = fixture.service.transcript.length, startB = at();
    const next = await createWorkflowUpdateFixture(t, { fixture, output: join(output, 'release-B') });
    update = await preparedInvocation({ fixture: next, output: join(output, 'actual-B') });
    fixture.service.faults.dropReportAfter = true;
    let second = await update.invoke('actual-main-deliver-lost-report-ack');
    check(second.exitCode !== 0, 'Lost reporting acknowledgement must stop actual main');
    const updateProcess = second;
    const endB = at(), countsB = withSourceRequests(requestCounts(fixture.service, startB, endB), next.bridge.calls);
    await recoverStoppedWorkflowOwner({ service: fixture.service, output, name: 'verified-stopped-B' });
    const savedB = parseJSON(await readFile(join(parseJSON(await readFile(update.configuration)).directory, 'workflow-state.private.json')));
    const currentBOptions = parseJSON(await readFile(update.configuration)), costB = await sessionCost(savedB.options.evidenceDirectory);
    const recovery = await prepareExpiredWorkflowReporting({ fixture: { ...next, configuration: { options: currentBOptions } }, output, paths: savedB.options });
    const reportRunner = join(output, 'actual-report-recovery'); await privateProofDirectory(reportRunner);
    const reportEnv = { ...update.env, RUNNER_TEMP: reportRunner, SHOP_COMPOSITION_COMMAND: 'recover-report', SHOP_COMPOSITION_REPORTING_AUTHORITY: await readFile(recovery.configuration.options.recoveryAuthority, 'utf8'), SHOP_ARTIFACT_RUN_ID: '', SHOP_ARTIFACT_RUN_ATTEMPT: '', SHOP_ARTIFACT_ID: '' };
    const preparedReport = await recordedProcess({ output, name: 'actual-prepare-report-only', args: [ci, 'prepare'], env: reportEnv, timeoutMs: 30000 });
    check(preparedReport.exitCode === 0, `Actual report prepare failed: ${preparedReport.stderrText}`);
    const reportConfiguration = parseJSON(Buffer.from(preparedReport.stdoutText)).configuration, reportOptions = parseJSON(await readFile(reportConfiguration));
    const reportInstallation = parseJSON(await readFile(reportOptions.installationPath));
    for (const kind of ['source', 'composition']) await rename(reportInstallation.signing[kind].path, `${reportInstallation.signing[kind].path}.unavailable`);
    const reportRuntimeEnv = { ...reportEnv, SHOP_COMPOSITION_INSTALLATION_PACKAGE: '', SHOP_COMPOSITION_INSTALLATION_PACKAGE_SHA256: '' };
    const reportBefore = fixture.service.transcript.length, brokerBefore = fixture.service.brokerCalls.length, startReport = at(), sourceStartReport = next.bridge.calls.length;
    const reportProcess = await recordedProcess({ output, name: 'actual-main-report-only', args: ['--require', update.transport.preload, entrypoint, '--configuration', reportConfiguration], env: reportRuntimeEnv, timeoutMs: 30000 });
    check(reportProcess.exitCode === 0, `Actual report-only recovery failed: ${reportProcess.stderrText}`);
    const reporting = parseJSON(Buffer.from(reportProcess.stdoutText)); check(reporting.controller.phase === 'report-confirmed', 'Report-only recovery did not confirm original acknowledgement');
    check(fixture.service.transcript.slice(reportBefore).every(item => item.url.includes('.s3.') || new URL(item.url).hostname === 'api.github.com' && item.method === 'GET'), 'Report recovery touched runtime provider');
    check(fixture.service.brokerCalls.slice(brokerBefore).every(item => item.action !== 'work-inventory' && !item.request?.operation?.startsWith('assets.')), 'Report recovery queried work/assets');
    const endReport = at(), countsReport = withSourceRequests(requestCounts(fixture.service, startReport, endReport), next.bridge.calls.slice(sourceStartReport));
    const latestHead = parseJSON(fixture.service.objects.get('head.json').bytes), latestEvent = parseJSON(fixture.service.objects.get(`events/${latestHead.eventDigest}.json`).bytes);
    second = { exitCode: 0, stdoutText: canonical({ controller: latestEvent.state.controller }) };
    check(second.exitCode === 0, `Actual main source update failed: ${second.stderrText}`);
    const resultB = parseJSON(Buffer.from(second.stdoutText), 16 * 1024 * 1024); check(resultB.controller.phase === 'complete', 'Source update did not complete');
    const changed = fixture.service.transcript.slice(before).filter(item => item.method !== 'GET' && !item.url.includes('.s3.') && !item.url.includes('/d1/database/'));
    check(changed.every(item => !item.url.includes('lambda.') && !item.url.includes('/synthetic-workflow-business/')), 'Unchanged business or native runtime was mutated');
    await rename(initialOptions.directory, `${initialOptions.directory}.unavailable`);
    const rollbackRunner = join(output, 'actual-rollback-runner'); await privateProofDirectory(rollbackRunner);
    const rollbackEnv = { ...update.env, RUNNER_TEMP: rollbackRunner, SHOP_COMPOSITION_COMMAND: 'rollback',
      SHOP_HISTORY_RUN_ID: retainedHistory.request.runId, SHOP_HISTORY_RUN_ATTEMPT: retainedHistory.request.runAttempt,
      SHOP_HISTORY_ARTIFACT_ID: retainedHistory.request.artifactId, SHOP_HISTORY_SOURCE_COMMIT: retainedHistory.request.sourceCommit };
    const startRollback = at(), sourceStartRollback = next.bridge.calls.length;
    const preparedRollback = await recordedProcess({ output, name: 'actual-prepare-historical-rollback', args: [ci, 'prepare'], env: rollbackEnv, timeoutMs: 30000 });
    check(preparedRollback.exitCode === 0, `Actual historical rollback prepare failed: ${preparedRollback.stderrText}`);
    const rollbackConfig = parseJSON(Buffer.from(preparedRollback.stdoutText)).configuration;
    const rollback = await recordedProcess({ output, name: 'actual-main-historical-rollback', args: ['--require', update.transport.preload, entrypoint, '--configuration', rollbackConfig], env: rollbackEnv, timeoutMs: 120000 });
    check(rollback.exitCode === 0, `Actual main historical rollback failed: ${rollback.stderrText}`);
    const endRollback = at(), countsRollback = withSourceRequests(requestCounts(fixture.service, startRollback, endRollback), next.bridge.calls.slice(sourceStartRollback));
    const rolled = parseJSON(Buffer.from(rollback.stdoutText), 16 * 1024 * 1024);
    check(rolled.controller.phase === 'complete' && rolled.controller.compositionDigest === resultA.controller.compositionDigest, 'Historical rollback did not restore exact composition');
    check(rolled.evidence.source === next.bootstrap.identity.head, 'Rollback must use exact current canonical source');
    nativeFixture = await createWorkflowNativeBootstrapFixture(t, { output: join(output, 'native-bootstrap'), keys: fixture.bootstrap.keys, recipientPrivateKeyFile: fixture.intake.privateKeyFile });
    nativeInvocation = await preparedInvocation({ fixture: nativeFixture, output: join(output, 'actual-native-bootstrap'), command: 'native-bootstrap' });
    const nativeStart = { provider: nativeFixture.service.transcript.length, custody: nativeFixture.service.brokerCalls.length };
    const nativeProcess = await nativeInvocation.invoke('actual-main-native-bootstrap');
    check(nativeProcess.exitCode === 0, `Actual native bootstrap failed: ${nativeProcess.stderrText}`);
    const nativeResult = parseJSON(Buffer.from(nativeProcess.stdoutText), 16 * 1024 * 1024);
    check(nativeResult.receipt.payload.scope === 'fixture/provider-loopback' && nativeResult.receipt.payload.awsImageQualified === false && nativeResult.readiness.awsImageQualified === false, 'Loopback native bootstrap cannot qualify AWS execution');
    check(!nativeFixture.service.objects.has('head.json') && [...nativeFixture.service.objects.keys()].some(key => /^native-qualification\/[a-f0-9]{64}\/head.json$/.test(key)), 'Native bootstrap must use its separate authenticated journal namespace');
    const nativeCounts = withSourceRequests(requestCounts(nativeFixture.service, nativeStart, { provider: nativeFixture.service.transcript.length, custody: nativeFixture.service.brokerCalls.length }), nativeFixture.bridge.calls);
    const nativeArchive = await createNativeQualificationArtifactFixture(t, { result: nativeResult, identity: nativeFixture.bootstrap.identity, portableFixture: nativeFixture.portable,
      recipientPrivateKeyFile: nativeFixture.intake.privateKeyFile, workflowId: 333, artifactId: 791, jobId: 990, originalDirectory: join(output, 'original-native-bootstrap') });
    fixture.archives.add(nativeArchive);
    const deniedNativeConfig = join(output, 'fixture-receipt-plan.private.json');
    await writeFile(deniedNativeConfig, canonical({ ...initialOptions, command: 'plan', directory: join(output, 'denied-fixture-receipt'), qualificationRequest: nativeArchive.request }), { flag: 'wx', mode: 0o600 });
    const beforeDeniedNative = fixture.service.transcript.length, beforeDeniedCustody = fixture.service.brokerCalls.length;
    const deniedNative = await recordedProcess({ output, name: 'actual-main-deny-fixture-qualification', args: ['--require', initial.transport.preload, entrypoint, '--configuration', deniedNativeConfig], env: initial.env, timeoutMs: 30000 });
    const deniedDiagnostics = join(output, 'denied-fixture-receipt/diagnostics');
    const deniedReasons = await Promise.all((await readdir(deniedDiagnostics)).map(async name => parseJSON(await readFile(join(deniedDiagnostics, name)), 1024 * 1024)));
    check(deniedNative.exitCode !== 0 && deniedReasons.some(record => record.causes.some(cause => cause.message === 'Complete real-provider native qualification result required')) && fixture.service.transcript.length === beforeDeniedNative && fixture.service.brokerCalls.length === beforeDeniedCustody, 'Fixture qualification receipt must fail before provider or custody access');
    negativeResults.push({ name: 'fixture-receipt-cannot-qualify-serving', providerCalls: 0, custodyCalls: 0, writes: 0 });
    const processCost = async (invocation, transportOutput) => parseJSON(await readFile(join(transportOutput, `process-cost-${invocation.pid}.private.json`)), 16 * 1024 * 1024);
    const runtimeChanges = changed.filter(item => new URL(item.url).hostname !== 'api.github.com');
    const summary = { coordinatorBudget: { updateMaximumRequests: 600, updateRequests: countsB.providerRequests + countsB.custodyCalls, met: countsB.providerRequests + countsB.custodyCalls <= 600, productionTimingClaim: false },
      processCosts: { initial: await processCost(first, join(output, 'actual-A/transport')), update: await processCost(updateProcess, join(output, 'actual-B/transport')), reportRecovery: await processCost(reportProcess, join(output, 'actual-B/transport')), historicalRollback: await processCost(rollback, join(output, 'actual-B/transport')) },
      releaseSessions: { initial: costA, update: costB, historicalRollback: await sessionCost(rolled.paths.evidenceDirectory) },
      nativeBootstrap: { actualPrepare: true, actualMain: true, executionScope: nativeResult.receipt.payload.scope, awsImageQualified: false, protocolOnly: true, realApplicationJobsExecuted: false, servingQualificationRejected: true, requests: nativeCounts },
      perReleaseRequests: { initial: countsA, update: countsB, reportRecovery: countsReport, historicalRollback: countsRollback }, schema: 'shop.delivery-path-acceptance/v1', actualPrepare: true, actualMain: true, authenticatedHostedHistory: true, originalHistoricalPathsUnavailable: true, initialRelease: resultA.controller.phase,
      storefrontUpdate: resultB.controller.phase, historicalRollback: rolled.controller.phase, reportingRecovery: reporting.controller.phase, recoveryRuntimeCalls: 0, originalArtifactsUnavailable: true, sourceExpiredBeforeRecovery: true, reportingMutationReplays: 0, negativeResults, freshCurrentSourceRollback: rolled.evidence.source === fixture.bootstrap.identity.head ? false : true, updateRuntimeMutations: runtimeChanges.length, updateReportingMutations: changed.length - runtimeChanges.length, updateNativeAndBusinessRuntimeMutations: runtimeChanges.filter(item => item.url.includes('lambda.') || item.url.includes('/synthetic-workflow-business/')).length, providerRequests: fixture.service.transcript.length,
      custodyCalls: fixture.service.brokerCalls.length, startedImplementationDigest, finishedImplementationDigest: await implementationDigest(), providerSimulated: true, realAwsQualified: false, productionDeliveryMeasured: false,
      transportMeasurement: { productionTlsMeasured: false, brokerSocketReuseMeasured: true, boundary: 'HTTP loopback replaces HTTPS destination; TLS handshakes are not represented by this rehearsal.' } };
    check(summary.startedImplementationDigest === summary.finishedImplementationDigest, 'Verifier source changed during acceptance');
    await writeFile(join(output, 'acceptance.private.json'), canonical(summary), { flag: 'wx', mode: 0o600 });
    check(summary.coordinatorBudget.met, `Coordinator request budget exceeded: ${summary.coordinatorBudget.updateRequests}/${summary.coordinatorBudget.updateMaximumRequests}`);
    return summary;
  } finally {
    try {
      const retainedJournals = { normal: await retainWorkflowProtocolEvidence(fixture.service, join(output, 'retained-normal-journals')),
        ...(nativeFixture ? { native: await retainWorkflowProtocolEvidence(nativeFixture.service, join(output, 'retained-native-journals')) } : {}) };
      await writeFile(join(output, 'protocol-transcript.private.json'), canonical({ retainedJournals, startedImplementationDigest, finishedImplementationDigest: await implementationDigest(), provider: fixture.service.transcript, custody: fixture.service.brokerCalls, brokerErrors: fixture.service.brokerErrors ?? [], cloudErrors: fixture.service.cloudErrors ?? [], ...(nativeFixture ? { nativeProvider: nativeFixture.service.transcript, nativeCustody: nativeFixture.service.brokerCalls, nativeBrokerErrors: nativeFixture.service.brokerErrors ?? [], nativeCloudErrors: nativeFixture.service.cloudErrors ?? [] } : {}) }), { flag: 'wx', mode: 0o600 });
    } finally { await initial?.close(); await update?.close(); await nativeInvocation?.close(); for (const callback of cleanup.reverse()) await callback(); }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, options: { network: { type: 'string' }, 'artifact-dir': { type: 'string' } } });
  check(values.network === 'loopback-only' && values['artifact-dir'], 'Use --network loopback-only --artifact-dir with a private SSD directory');
  return runDeliveryPathAcceptance({ output: resolve(values['artifact-dir']) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(result => process.stdout.write(`${canonical(result)}\n`)).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
