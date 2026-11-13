import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical, check, digest, parseJSON } from '../data.mjs';
import { verifyPortableBundle } from '../portable-bundle.mjs';
import { createBootstrapFixture } from './bootstrap-fixture.mjs';
import { createWorkflowJourneyFixture, createWorkflowUpdateFixture, prepareExpiredWorkflowReporting, privateProofDirectory, recordedProcess,
  recoverStoppedWorkflowOwner, retainedWorkflowPlanTargets, retainWorkflowProtocolEvidence, workflowApiBridge, workflowCorruptionProbes, workflowFixtureBoundaries } from './workflow-journey-fixture.mjs';

const executable = fileURLToPath(import.meta.url);
const phase = result => result.controller?.phase ?? result.phase;

export async function workflowChild(configuration) {
  const boundaries = workflowFixtureBoundaries(configuration.boundaries);
  if (configuration.mode === 'hosted-execution-probe') {
    const { hostedController } = await import('../hosted-controller.mjs');
    return { controller: await hostedController(configuration.options, boundaries) };
  }
  check(configuration.mode === undefined, 'Unknown workflow proof process mode');
  const { workflowEntrypoint } = await import('../workflow-entrypoint.mjs');
  return workflowEntrypoint(configuration.options, boundaries);
}

export async function workflowInvocation({ output, name, configuration, timeoutMs = 30000 }) {
  await privateProofDirectory(output);
  const config = join(output, `${name}-configuration.private.json`);
  await writeFile(config, canonical(configuration), { flag: 'wx', mode: 0o600 });
  const process = await recordedProcess({ output, name, args: [executable, '--child', config], timeoutMs });
  return { ...process, result: process.exitCode === 0 ? parseJSON(Buffer.from(process.stdoutText), 16 * 1024 * 1024) : null };
}

export function workflowIdentityProbes(configuration) {
  const altered = (field, value) => ({ ...configuration, options: { ...configuration.options,
    env: { ...configuration.options.env, [field]: value } } });
  return [
    { name: 'wrong-installed-root-pin', configuration: { ...configuration, options: { ...configuration.options, installationDigest: '0'.repeat(64) } } },
    { name: 'wrong-source', configuration: altered('GITHUB_SHA', '2'.repeat(40)) },
    { name: 'wrong-workflow', configuration: altered('GITHUB_WORKFLOW_REF', 'bentbrain/bent-mono/.github/workflows/other.yml@refs/heads/main') },
    { name: 'wrong-run', configuration: altered('GITHUB_RUN_ID', '999') },
    { name: 'wrong-attempt', configuration: altered('GITHUB_RUN_ATTEMPT', '9') },
    { name: 'wrong-repository', configuration: altered('GITHUB_REPOSITORY_ID', '999') },
  ].map(probe => ({ ...probe, configuration: { ...probe.configuration, options: { ...probe.configuration.options,
    directory: join(dirname(configuration.options.directory), `rejected-${probe.name}`) } } }));
}

// The fixture supplies only the external protocol endpoints and installed
// inputs. The executable source entrypoint owns intake, assembly and issuance.
export async function runWorkflowJourney({ output, configuration, service, apiBridge, negativeCases = [], stopAt = 'complete', timeoutMs = 30000,
  exerciseRecovery = false, prepareReportingRecovery, postAdmissionProbes }) {
  await privateProofDirectory(output);
  const startedAt = Date.now(), invocations = [], findings = {}, initialProviderCalls = service?.transcript.length ?? 0;
  const initialReports = service?.reports.length ?? 0;
  let currentConfiguration = configuration;
  const invoke = async (name, next = currentConfiguration) => {
    const result = await workflowInvocation({ output, name, configuration: next, timeoutMs }); invocations.push(result);
    return result;
  };
  let failure = null, final = null;
  const runtimeRequests = () => service.transcript.filter(item => ['api.cloudflare.com', `lambda.${service.policy.region}.amazonaws.com`].includes(new URL(item.url).hostname));
  const runtimeWrites = () => runtimeRequests().filter(item => item.method !== 'GET');
  try {
    for (const probe of negativeCases) {
      const beforeProvider = service?.transcript.length ?? 0, beforeBroker = service?.brokerCalls.length ?? 0;
      const result = await invoke(`reject-${probe.name}`, probe.configuration);
      check(result.exitCode !== 0 && result.signal === null && !result.timedOut, `Invalid ${probe.name} was accepted or failed to terminate`);
      check((service?.transcript.length ?? 0) === beforeProvider && (service?.brokerCalls.length ?? 0) === beforeBroker, `Invalid ${probe.name} reached provider custody`);
      findings[probe.name] = { rejected: true, providerCalls: 0, brokerCalls: 0, diagnostic: result.stderr.sha256 };
    }
    for (let count = 0; count < 80; count++) {
      const result = await invoke(`advance-${String(count).padStart(3, '0')}`);
      check(result.exitCode === 0, `Workflow source transition failed, inspect ${result.stderr.path}`);
      check(!result.result.waiting && !result.result.controller?.waiting, 'Workflow source transition has an unresolved acknowledgement');
      final = result.result;
      if (postAdmissionProbes && phase(final) === 'prepared' && !findings.adversarialBytes) findings.adversarialBytes = await postAdmissionProbes(final.paths, invoke);
      if (currentConfiguration.options.command === 'begin') currentConfiguration = { ...currentConfiguration,
        options: { ...currentConfiguration.options, command: 'advance' } };
      if (exerciseRecovery && phase(final) === 'stage-intent' && !findings.unknownUploadAcknowledgement) {
        const beforeWrites = runtimeWrites().length;
        service.faults.dropUploadAfter = true;
        const lost = await invoke('lost-worker-acknowledgement');
        check(lost.exitCode !== 0 && runtimeWrites().length === beforeWrites + 1, 'Lost upload acknowledgement must retain exactly one mutation');
        const held = await invoke('uncertain-owner-held');
        check(held.exitCode !== 0 && runtimeWrites().length === beforeWrites + 1, 'Uncertain owner must remain held before explicit recovery');
        const recovery = await recoverStoppedWorkflowOwner({ service, output, name: 'upload' });
        const resumed = await invoke('upload-get-only-reconciliation');
        check(resumed.exitCode === 0 && phase(resumed.result) === 'staging' && runtimeWrites().length === beforeWrites + 1, 'Upload reconciliation repeated a mutation');
        findings.unknownUploadAcknowledgement = { originalFailure: lost.stderr.sha256, heldFailure: held.stderr.sha256,
          recovery, providerMutationCount: 1, repeatedMutations: 0, resumedPhase: phase(resumed.result) };
        final = resumed.result;
      }
      if (exerciseRecovery && phase(final) === 'report-intent' && !findings.reportingRecovery) {
        check(typeof prepareReportingRecovery === 'function', 'Explicit independently signed reporting recovery fixture required');
        service.faults.dropReportAfter = true;
        const lost = await invoke('lost-report-acknowledgement');
        check(lost.exitCode !== 0 && service.reports.length === initialReports + 1, 'Lost report acknowledgement must retain one immutable verified report');
        const recovery = await recoverStoppedWorkflowOwner({ service, output, name: 'report' });
        const prepared = await prepareReportingRecovery(final.paths);
        const beforeRuntime = runtimeRequests().length, beforeInventory = service.brokerCalls.filter(call => call.action === 'work-inventory').length;
        const beforeReports = service.transcript.filter(item => item.method === 'POST' && new URL(item.url).hostname === 'api.github.com').length;
        const resumed = await invoke('expired-inputs-report-only-reconciliation', prepared.configuration);
        check(resumed.exitCode === 0 && phase(resumed.result) === 'report-confirmed', 'Reporting-only recovery failed');
        check(runtimeRequests().length === beforeRuntime && service.brokerCalls.filter(call => call.action === 'work-inventory').length === beforeInventory,
          'Reporting-only recovery read runtime or accepted-work inventory');
        check(service.transcript.filter(item => item.method === 'POST' && new URL(item.url).hostname === 'api.github.com').length === beforeReports,
          'Reporting-only reconciliation repeated a report mutation');
        const head = JSON.parse(service.objects.get('head.json').bytes), saved = JSON.parse(service.objects.get(`events/${head.eventDigest}.json`).bytes);
        check(saved.state.controller.phase === 'complete', 'Reporting reconciliation did not durably complete the original release');
        findings.reportingRecovery = { originalFailure: lost.stderr.sha256, recovery, ...prepared.evidence,
          runtimeRequests: 0, acceptedWorkRequests: 0, repeatedReportMutations: 0, journalPhase: saved.state.controller.phase };
        final = resumed.result; break;
      }
      if (phase(final) === stopAt) break;
    }
    check(final && (phase(final) === stopAt || stopAt === 'complete' && findings.reportingRecovery?.journalPhase === 'complete'), 'Workflow source transition bound reached');
    if (stopAt === 'plan-admitted') check((service?.transcript.length ?? 0) === initialProviderCalls, 'Plan rehearsal reached provider custody');
    findings.final = { phase: phase(final), compositionDigest: final.compositionDigest ?? final.controller?.compositionDigest ?? null, resultDigest: digest(final) };
  } catch (error) { failure = { message: error.message, stack: error.stack }; }
  const journals = service ? await retainWorkflowProtocolEvidence(service, output) : null;
  const requestCounts = service ? { initialSetup: initialProviderCalls, transitions: service.transcript.length - initialProviderCalls,
    controllerStoreReads: 0, controllerStoreWrites: 0, custodyStoreReads: 0, custodyStoreWrites: 0,
    runtimeReads: 0, runtimeWrites: 0, reportingReads: 0, reportingWrites: 0, custodyActions: {} } : null;
  if (service) {
    for (const request of service.transcript.slice(initialProviderCalls)) {
      const url = new URL(request.url), store = url.hostname === `${service.policy.store.bucket}.s3.${service.policy.region}.amazonaws.com`;
      const category = store ? url.pathname.startsWith(`/${service.custodyPolicy.store.prefix}/`) ? 'custodyStore' : 'controllerStore'
        : url.hostname === 'api.github.com' ? 'reporting' : 'runtime';
      requestCounts[`${category}${request.method === 'GET' ? 'Reads' : 'Writes'}`]++;
    }
    for (const call of service.brokerCalls) requestCounts.custodyActions[call.action] = (requestCounts.custodyActions[call.action] ?? 0) + 1;
  }
  const summary = { schema: 'shop.source-workflow-journey-proof/v1', scope: 'synthetic-source-workflow-probe',
    startedAt, finishedAt: Date.now(), complete: failure === null, realAwsQualified: false, realCustomerJourney: false,
    productionDeliveryMeasured: false, providerSimulated: true, installedSourceAuthorityExercised: final !== null,
    failure, findings, invocations: invocations.length, sourceApiCalls: apiBridge?.calls.length ?? null,
    providerRequests: service?.transcript.length ?? null, custodyCalls: service?.brokerCalls.length ?? null, requestCounts, journals,
    noClaimLimits: ['Synthetic provider responses and signing credentials', 'Synthetic source and quality API responses',
      'Synthetic retained-code execution', 'Cloud image and Production delivery require guarded qualification'] };
  await writeFile(join(output, 'workflow-summary.private.json'), canonical(summary), { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, 'workflow-invocations.private.json'), canonical(invocations.map(({ stdoutText: _out, stderrText: _err, ...record }) => record)), { flag: 'wx', mode: 0o600 });
  if (service) {
    await writeFile(join(output, 'provider-transcript.private.json'), canonical(service.transcript), { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'custody-transcript.private.json'), canonical(service.brokerCalls), { flag: 'wx', mode: 0o600 });
  }
  if (apiBridge) await writeFile(join(output, 'source-api-transcript.private.json'), canonical(apiBridge.calls), { flag: 'wx', mode: 0o600 });
  return { summary, invocations, final };
}

export async function runWorkflowUpdate({ fixture, first, output }) {
  check(first.summary.complete && phase(first.final) === 'complete', 'A complete first source release is required');
  const jobs = ['business', 'native'].map(component => ({ component, artifactDigest: fixture.portable.verified.components.get(component).artifact.codeDigest, format: 'job-v1' }));
  for (const job of jobs) fixture.service.workDb.prepare('INSERT INTO accepted_jobs(component,artifact_digest,format,status) VALUES(?,?,?,?)').run(job.component, job.artifactDigest, job.format, 'accepted');
  const before = fixture.service.transcript.length;
  const next = await createWorkflowUpdateFixture({ after() {} }, { fixture, output: join(output, 'source-B') });
  try {
    const update = await runWorkflowJourney({ output: join(output, 'source-B'), configuration: next.configuration,
      service: fixture.service, apiBridge: next.bridge });
    check(update.summary.complete, `Source B workflow did not complete: ${update.summary.failure?.message ?? 'unknown'}; ${update.invocations.at(-1)?.stderrText ?? ''}`);
    const mutations = fixture.service.transcript.slice(before).filter(item => item.method !== 'GET' &&
      ['api.cloudflare.com', `lambda.${fixture.policy.region}.amazonaws.com`].includes(new URL(item.url).hostname));
    check(mutations.length === 2 && mutations.every(item => item.url.includes('synthetic-workflow-storefront')), 'Storefront source update changed another runtime');
    const retained = fixture.service.workDb.prepare('SELECT component,artifact_digest AS artifactDigest,format FROM accepted_jobs ORDER BY component').all();
    check(canonical(retained) === canonical(jobs), 'Source update changed original accepted work');
    const evidence = { schema: 'shop.synthetic-source-update-proof/v1', complete: true, sourceA: fixture.bootstrap.identity.head,
      sourceB: next.bootstrap.identity.head, rootDigest: fixture.bootstrap.installation.rootDigest,
      nativeAndBusinessMutations: 0, storefrontMutations: mutations.length, acceptedWorkScope: 'synthetic-sql-observation', acceptedWork: jobs,
      sourceACompositionDigest: first.final.controller.compositionDigest, sourceBCompositionDigest: update.final.controller.compositionDigest,
      realAwsQualified: false, realCustomerJourney: false, productionDeliveryMeasured: false, rollbackQualified: false };
    await writeFile(join(output, 'source-update-summary.private.json'), canonical(evidence), { flag: 'wx', mode: 0o600 });
    return { evidence, update, fixture: next };
  } finally { await next.bridge.close(); }
}

export async function runRetainedWorkflowPlan({ output, input, portableDirectory, expected, sourceBase, sourceTree, currentMain }) {
  await privateProofDirectory(output);
  const portable = await verifyPortableBundle(portableDirectory, expected);
  const artifactMetadata = await input.api.getJSON(`/repos/bentbrain/bent-mono/actions/artifacts/${input.request.artifactId}`);
  check(portable.manifest.awsImageQualified === false && portable.manifest.originSourceCommit === input.request.sourceCommit,
    'Original retained source and unqualified runtime identity required');
  // This independent test installation reads the previously authenticated
  // retained metadata. The entrypoint performs its own original archive intake.
  const targets = retainedWorkflowPlanTargets(portable);
  const bootstrap = await createBootstrapFixture({ after() {} }, { root: output, intakeFixture: input,
    imported: { portable }, sourceCommit: input.request.sourceCommit, sourceBase, providerPolicy: targets.policy, plan: targets.plan,
    runner: Buffer.from('throw Error("Historical retained plan runs no journey");') });
  check(/^[a-f0-9]{40}$/.test(sourceTree) && /^[a-f0-9]{40}$/.test(currentMain), 'Exact historical tree and current canonical source required');
  bootstrap.quality.documents.get(`/repos/bentbrain/bent-mono/git/commits/${input.request.sourceCommit}`).tree.sha = sourceTree;
  const bridge = await workflowApiBridge({ intakeApi: input.api, qualityApi: bootstrap.qualityApi, output: join(output, 'api-bridge') });
  try {
    const configuration = { options: { installationPath: bootstrap.installationPath, installationDigest: bootstrap.installationDigest,
      request: input.request, directory: join(output, 'workflow'), command: 'plan', acceptedAt: bootstrap.acceptedAt, env: bootstrap.env },
      boundaries: { apiOrigin: bridge.origin, custodyOrigin: bridge.origin } };
    const mismatch = await workflowInvocation({ output, name: 'historical-artifact-current-main-rejected', configuration: {
      ...configuration, options: { ...configuration.options, directory: join(output, 'rejected-current-main'), env: { ...bootstrap.env,
        GITHUB_SHA: currentMain, GITHUB_WORKFLOW_SHA: currentMain } } } });
    check(mismatch.exitCode !== 0 && bridge.calls.length === 0, 'Historical artifact must reject current-main relabeling before intake or custody');
    const result = await workflowInvocation({ output, name: 'original-retained-source-plan', configuration, timeoutMs: 420000 });
    check(result.exitCode === 0 && phase(result.result) === 'plan-admitted', `Original retained plan failed: ${result.stderrText}`);
    check(result.result.controller.readiness.awsImageQualified === false && result.result.controller.providerWrites === 0,
      'Historical native runtime must remain unqualified with zero provider writes');
    const execution = await workflowInvocation({ output, name: 'historical-unqualified-native-execution-rejected', configuration: {
      mode: 'hosted-execution-probe', options: { ...result.result.paths, command: 'advance', env: bootstrap.env },
      boundaries: configuration.boundaries } });
    check(execution.exitCode !== 0 && /Hosted artifact format or native runtime identity differs|AWS image qualification/.test(execution.stderrText) &&
      !bridge.calls.some(call => call.kind === 'forbidden-custody'), 'Original native runtime must reject execution before custody');
    const summary = { schema: 'shop.historical-original-workflow-plan-proof/v1', complete: true,
      source: input.request.sourceCommit, currentCanonicalMain: currentMain, historicalMetadata: true,
      metadataOrigin: input.metadataOrigin, metadataRefs: input.metadataRefs, originalArtifactDigest: artifactMetadata.digest,
      originalArtifactBytes: artifactMetadata.size_in_bytes, canonicalSourceAndQualityApi: 'synthetic-recording', installedAuthority: 'independent-synthetic-test-keys',
      manifestSha256: portable.manifestSha256, portableFiles: portable.manifest.files.length, originalArchive: input.original,
      currentMainRelabelingRejected: true, unqualifiedNativeExecutionRejected: true, providerCustodyCalls: 0,
      targetReadiness: 'unqualified-test-installation', plan: result.result.controller, sourceApiCalls: bridge.calls.length,
      realAwsQualified: false, currentCanonicalAdmission: false, nativeExecution: false, productionDeliveryMeasured: false };
    await writeFile(join(output, 'historical-plan-summary.private.json'), canonical(summary), { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'historical-plan-api-transcript.private.json'), canonical(bridge.calls), { flag: 'wx', mode: 0o600 });
    return summary;
  } finally { await bridge.close(); }
}

async function main() {
  const { values } = parseArgs({ strict: true, options: { child: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, update: { type: 'boolean' } } });
  check(values.child || values.output, 'Provide a private --output directory or one private --child configuration');
  if (values.child) return workflowChild(parseJSON(await readFile(resolve(values.child)), 16 * 1024 * 1024));
  const output = resolve(values.output);
  if (values.config) {
    const configuration = parseJSON(await readFile(resolve(values.config)), 16 * 1024 * 1024);
    const result = await runWorkflowJourney({ output, configuration, stopAt: configuration.options.command === 'plan' ? 'plan-admitted' : 'complete' });
    if (!result.summary.complete) process.exitCode = 1;
    return result.summary;
  }
  // Keep the original encrypted artifact and installed fixture evidence. Close
  // only the active protocol services after retaining the final transcripts.
  const fixture = await createWorkflowJourneyFixture({ after() {} }, { output, maximumLifetimeMs: values.update ? 600000 : 60000 });
  try {
    const result = await runWorkflowJourney({ output, configuration: fixture.configuration, service: fixture.service,
      apiBridge: fixture.bridge, negativeCases: workflowIdentityProbes(fixture.configuration), exerciseRecovery: !values.update,
      postAdmissionProbes: (paths, invoke) => workflowCorruptionProbes({ fixture, paths, output, invoke }),
      prepareReportingRecovery: paths => prepareExpiredWorkflowReporting({ fixture, output, paths }) });
    if (!result.summary.complete) process.exitCode = 1;
    if (values.update && result.summary.complete) {
      return (await runWorkflowUpdate({ fixture, first: result, output })).evidence;
    }
    return result.summary;
  } finally { await fixture.bridge.close(); await fixture.service.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(`${canonical(result)}\n`)).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
