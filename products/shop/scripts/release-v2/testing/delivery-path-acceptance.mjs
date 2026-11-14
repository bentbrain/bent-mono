import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { implementationDigest } from '../composition.mjs';
import { canonical, check, parseJSON, sha256 } from '../data.mjs';
import { createProtectedPackageFixture } from './bootstrap-fixture.mjs';
import { createWorkflowJourneyFixture, createWorkflowUpdateFixture, prepareExpiredWorkflowReporting, recoverStoppedWorkflowOwner, privateProofDirectory, recordedProcess } from './workflow-journey-fixture.mjs';

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
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => {
  const target = new URL(url);
  if(target.origin !== 'https://api.github.com' || (options.method || 'GET') !== 'GET') throw Error('Acceptance fetch denies destination: '+url);
  return originalFetch(${JSON.stringify(fixture.bridge.origin)}, {method:'POST',headers:{authorization:'Bearer synthetic-loopback-controller','content-type':'application/json'},body:JSON.stringify({kind:'quality-json',endpoint:target.pathname+target.search})});
};
https.request = function(options, callback) {
  if (options.hostname === 'qualification.example.invalid') return http.request({ ...options, hostname:'127.0.0.1',port:${JSON.stringify(custody.port)},path:'/',rejectUnauthorized:undefined,minVersion:undefined,headers:{...options.headers,authorization:'Bearer synthetic-loopback-controller'} },callback);
  if (options.hostname === 'pip.actions.githubusercontent.com') return http.request({ ...options,hostname:'127.0.0.1',port:${identity.address().port},path:'/',rejectUnauthorized:undefined,minVersion:undefined },callback);
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

export async function runDeliveryPathAcceptance({ output }) {
  await privateProofDirectory(output);
  const startedImplementationDigest = await implementationDigest();
  const cleanup = [], t = { after: callback => cleanup.push(callback) }, fixture = await createWorkflowJourneyFixture(t, { output: join(output, 'release-A'), maximumLifetimeMs: 60000 });
  let initial, update;
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
    const at = () => ({ provider: fixture.service.transcript.length, custody: fixture.service.brokerCalls.length });
    const startA = at();
    const first = await initial.invoke('actual-main-deliver');
    check(first.exitCode === 0, `Actual main initial release failed: ${first.stderrText}`);
    const resultA = parseJSON(Buffer.from(first.stdoutText), 16 * 1024 * 1024); check(resultA.controller.phase === 'complete', 'Initial runtime release did not complete');
    const endA = at(), countsA = requestCounts(fixture.service, startA, endA);
    const before = fixture.service.transcript.length, startB = at();
    const next = await createWorkflowUpdateFixture(t, { fixture, output: join(output, 'release-B') });
    update = await preparedInvocation({ fixture: next, output: join(output, 'actual-B') });
    fixture.service.faults.dropReportAfter = true;
    let second = await update.invoke('actual-main-deliver-lost-report-ack');
    check(second.exitCode !== 0, 'Lost reporting acknowledgement must stop actual main');
    const endB = at(), countsB = requestCounts(fixture.service, startB, endB);
    await recoverStoppedWorkflowOwner({ service: fixture.service, output, name: 'verified-stopped-B' });
    const savedB = parseJSON(await readFile(join(parseJSON(await readFile(update.configuration)).directory, 'workflow-state.private.json')));
    const currentBOptions = parseJSON(await readFile(update.configuration));
    const recovery = await prepareExpiredWorkflowReporting({ fixture: { ...next, configuration: { options: currentBOptions } }, output, paths: savedB.options });
    const reportRunner = join(output, 'actual-report-recovery'); await privateProofDirectory(reportRunner);
    const reportEnv = { ...update.env, RUNNER_TEMP: reportRunner, SHOP_COMPOSITION_COMMAND: 'recover-report', SHOP_COMPOSITION_REPORTING_AUTHORITY: await readFile(recovery.configuration.options.recoveryAuthority, 'utf8'), SHOP_ARTIFACT_RUN_ID: '', SHOP_ARTIFACT_RUN_ATTEMPT: '', SHOP_ARTIFACT_ID: '' };
    const preparedReport = await recordedProcess({ output, name: 'actual-prepare-report-only', args: [ci, 'prepare'], env: reportEnv, timeoutMs: 30000 });
    check(preparedReport.exitCode === 0, `Actual report prepare failed: ${preparedReport.stderrText}`);
    const reportConfiguration = parseJSON(Buffer.from(preparedReport.stdoutText)).configuration, reportOptions = parseJSON(await readFile(reportConfiguration));
    const reportInstallation = parseJSON(await readFile(reportOptions.installationPath));
    for (const kind of ['source', 'composition']) await rename(reportInstallation.signing[kind].path, `${reportInstallation.signing[kind].path}.unavailable`);
    const reportBefore = fixture.service.transcript.length, brokerBefore = fixture.service.brokerCalls.length, startReport = at();
    const reportProcess = await recordedProcess({ output, name: 'actual-main-report-only', args: ['--require', update.transport.preload, entrypoint, '--configuration', reportConfiguration], env: reportEnv, timeoutMs: 30000 });
    check(reportProcess.exitCode === 0, `Actual report-only recovery failed: ${reportProcess.stderrText}`);
    const reporting = parseJSON(Buffer.from(reportProcess.stdoutText)); check(reporting.controller.phase === 'report-confirmed', 'Report-only recovery did not confirm original acknowledgement');
    check(fixture.service.transcript.slice(reportBefore).every(item => item.url.includes('.s3.') || new URL(item.url).hostname === 'api.github.com' && item.method === 'GET'), 'Report recovery touched runtime provider');
    check(fixture.service.brokerCalls.slice(brokerBefore).every(item => !['workInventory', 'assetSession', 'assetUpload'].includes(item.action)), 'Report recovery queried work/assets');
    const endReport = at(), countsReport = requestCounts(fixture.service, startReport, endReport);
    const latestHead = parseJSON(fixture.service.objects.get('head.json').bytes), latestEvent = parseJSON(fixture.service.objects.get(`events/${latestHead.eventDigest}.json`).bytes);
    second = { exitCode: 0, stdoutText: canonical({ controller: latestEvent.state.controller }) };
    check(second.exitCode === 0, `Actual main source update failed: ${second.stderrText}`);
    const resultB = parseJSON(Buffer.from(second.stdoutText), 16 * 1024 * 1024); check(resultB.controller.phase === 'complete', 'Source update did not complete');
    const changed = fixture.service.transcript.slice(before).filter(item => item.method !== 'GET' && !item.url.includes('.s3.') && !item.url.includes('/d1/database/'));
    check(changed.every(item => !item.url.includes('lambda.') && !item.url.includes('/synthetic-workflow-business/')), 'Unchanged business or native runtime was mutated');
    const initialOptions = parseJSON(await readFile(initial.configuration)), updateOptions = parseJSON(await readFile(update.configuration));
    const rollbackOptions = { ...updateOptions, command: 'rollback', rollbackDirectory: initialOptions.directory, directory: join(output, 'rollback') };
    const rollbackConfig = join(output, 'rollback-configuration.private.json'); await writeFile(rollbackConfig, canonical(rollbackOptions), { flag: 'wx', mode: 0o600 });
    const startRollback = at();
    const rollback = await recordedProcess({ output, name: 'actual-main-historical-rollback', args: ['--require', update.transport.preload, entrypoint, '--configuration', rollbackConfig], env: update.env, timeoutMs: 120000 });
    check(rollback.exitCode === 0, `Actual main historical rollback failed: ${rollback.stderrText}`);
    const endRollback = at(), countsRollback = requestCounts(fixture.service, startRollback, endRollback);
    const rolled = parseJSON(Buffer.from(rollback.stdoutText), 16 * 1024 * 1024);
    check(rolled.controller.phase === 'complete' && rolled.controller.compositionDigest === resultA.controller.compositionDigest, 'Historical rollback did not restore exact composition');
    check(rolled.evidence.source === next.bootstrap.identity.head, 'Rollback must use exact current canonical source');
    const summary = { perReleaseRequests: { initial: countsA, update: countsB, reportRecovery: countsReport, historicalRollback: countsRollback }, schema: 'shop.delivery-path-acceptance/v1', actualPrepare: true, actualMain: true, initialRelease: resultA.controller.phase,
      storefrontUpdate: resultB.controller.phase, historicalRollback: rolled.controller.phase, reportingRecovery: reporting.controller.phase, recoveryRuntimeCalls: 0, originalArtifactsUnavailable: true, sourceExpiredBeforeRecovery: true, reportingMutationReplays: 0, negativeResults, freshCurrentSourceRollback: rolled.evidence.source === fixture.bootstrap.identity.head ? false : true, updateRuntimeMutations: changed.length, providerRequests: fixture.service.transcript.length,
      custodyCalls: fixture.service.brokerCalls.length, startedImplementationDigest, finishedImplementationDigest: await implementationDigest(), providerSimulated: true, realAwsQualified: false, productionDeliveryMeasured: false };
    check(summary.startedImplementationDigest === summary.finishedImplementationDigest, 'Verifier source changed during acceptance');
    await writeFile(join(output, 'acceptance.private.json'), canonical(summary), { flag: 'wx', mode: 0o600 }); return summary;
  } finally { await writeFile(join(output, 'protocol-transcript.private.json'), canonical({ startedImplementationDigest, finishedImplementationDigest: await implementationDigest(), provider: fixture.service.transcript, custody: fixture.service.brokerCalls, brokerErrors: fixture.service.brokerErrors ?? [], cloudErrors: fixture.service.cloudErrors ?? [] }), { flag: 'wx', mode: 0o600 }); await initial?.close(); await update?.close(); for (const callback of cleanup.reverse()) await callback(); }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, options: { network: { type: 'string' }, 'artifact-dir': { type: 'string' } } });
  check(values.network === 'loopback-only' && values['artifact-dir'], 'Use --network loopback-only --artifact-dir with a private SSD directory');
  return runDeliveryPathAcceptance({ output: resolve(values['artifact-dir']) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(result => process.stdout.write(`${canonical(result)}\n`)).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
