import { resolveServingPlan, assertServingPlanAuthority, assertServingComponentBinding } from './serving-plan.mjs';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubApi, requireReviewedHead } from '../../../../scripts/require-release-checks.mjs';
import { parseArgs } from 'node:util';
import { canonical, check, digest, parseJSON, readRef, readRegularFile, same, sha256 } from './data.mjs';
import { selectedVersion } from './component-identity.mjs';
import { compatible } from './composition.mjs';
import { advanceWithPorts } from './controller.mjs';
import { actionsIdentity, admitHostedComposition, readInstalledRoot, verifyHostedAuthority } from './hosted-admission.mjs';
import { exactFields, protocolPolicy } from './provider-protocol-builders.mjs';
import { verifyPortableBundle } from './portable-bundle.mjs';
import { admitCredentialFence, credentialBrokerBoundary, createHostedWriter } from './hosted-writer.mjs';
import { createHostedProvider, preflightHostedTargets, retainedCandidateLoader, retainHostedRequestGraph } from './hosted-provider.mjs';
import { createBrokerTransport, requestBrokerIdentity } from './broker-transport.mjs';
import { journey } from './journey.mjs';
import { hostedReporting } from './hosted-reporting.mjs';
import { saveHostedFailure } from './hosted-diagnostics.mjs';
import { snapshotRelease } from './release-snapshot.mjs';

const commands = new Set(['plan', 'advance', 'begin', 'rollback', 'recover-report']);

export async function admitHostedInvocation(options) {
  check(commands.has(options.command ?? 'plan'), 'Unknown hosted qualification operation');
  const identity = actionsIdentity(options.env ?? process.env);
  const admission = await admitHostedComposition({ ...options, identity });
  const authority = admission.hostedAuthority.payload;
  const bytes = await readRegularFile(options.targetPlan, 16 * 1024 * 1024, true); check(bytes.length <= 16 * 1024 * 1024 && sha256(bytes) === authority.targetPlanDigest, 'Signed target plan bytes differ');
  const plan = parseJSON(bytes, 16 * 1024 * 1024, { finiteFractions: true });
  exactFields(plan, ['schema', 'scope', 'providerPolicy', 'targets', 'deploymentId', 'journeyOrigin']);
  check(plan.schema === 'shop.hosted-target-plan/v1' && plan.scope === 'isolated-qualification', 'Isolated target plan required');
  const policy = protocolPolicy(plan.providerPolicy);
  check(digest(policy) === authority.providerPolicyDigest && policy.github.environment === admission.root.environment &&
    policy.github.repository === admission.root.repositoryName && (policy.github.reporting === 'per-release' ? plan.deploymentId === null : policy.github.deploymentIds.includes(plan.deploymentId)), 'Target policy or reporting installation differs');
  check(Array.isArray(plan.targets), 'Exact target component map required');
  check(plan.targets.every(item => item.kind === (item.component === 'native' ? 'lambda' : 'worker')), 'Shop component runtime target differs');
  check(Array.isArray(plan.targets) && same(plan.targets.map(item => item.component).sort(), admission.payload.components.map(item => item.id).sort()) &&
    new Set(plan.targets.map(item => item.component)).size === plan.targets.length, 'Exact target component map required');
  check(admission.trust.runner.origins.includes(plan.journeyOrigin), 'Qualified journey origin differs');
  const portableRoot = await realpath(options.portable);
  const manifestRef = { path: 'portable-bundle.json', bytes: (await lstat(resolve(portableRoot, 'portable-bundle.json'))).size,
    sha256: authority.portableManifests[0].manifestSha256 };
  check(authority.portableManifests.every(item => item.manifestSha256 === manifestRef.sha256), 'One sealed portable release bundle required');
  const manifest = parseJSON(await readRef(portableRoot, manifestRef), 16 * 1024 * 1024);
  check(authority.portableManifests.every(item => item.lineageDigest === digest(manifest.lineage)), 'Externally authenticated artifact lineage differs');
  const portable = await verifyPortableBundle(portableRoot, { manifestSha256: manifestRef.sha256,
    originSourceCommit: manifest.originSourceCommit, lineage: manifest.lineage, requireHostedLineage: true });
  for (const component of admission.payload.components) {
    const imported = portable.components.get(component.id);
    check(imported && same(imported.artifactRef, component.artifact) && same(imported.provenanceRef, component.provenance) &&
      imported.artifact.codeDigest === component.codeDigest && imported.artifact.runtimeDigest === admission.artifacts.get(component.id).runtimeDigest,
    'Assembly changed the authenticated portable component');
  }
  check(same(portable.closurePolicy, admission.trust.closurePolicy), 'Portable dependency policy differs from composition admission');
  const resolvedPlan = resolveServingPlan({ plan, policy, components: admission.payload.components, portable,
    ...(policy.nativeQualification ? { nativeQualification: { root: admission.root, receipts: authority.nativeQualifications ?? [],
      qualificationPolicy: policy.nativeQualification, environmentId: admission.root.credentialBroker.environmentId,
      policyDigest: digest(policy.nativeQualification), secretVersionsDigest: digest(authority.secretInstallations) } } : {}) });
  const admittedPlan = assertServingPlanAuthority(resolvedPlan, authority);
  await assertServingComponentBinding({ bundle: options.bundle, components: admission.payload.components, policy,
    selection: resolvedPlan.authorityFields.nativeServingSelection });
  return { admission, authority, plan: admittedPlan, policy, portable };
}

async function revalidateSource(options, authority, boundaries, retainedEvidence) {
  // Older explicitly assembled callers retain their signed, bounded authority;
  // the installed default route additionally binds its actual guard transcript.
  if (!options.sourceEvidence) return;
  const evidence = retainedEvidence ?? parseJSON(await readRegularFile(options.sourceEvidence, 32 * 1024 * 1024, true), 32 * 1024 * 1024);
  check(digest(evidence) === authority.quality.releaseGuardDigest && evidence.source === authority.head, 'Current source evidence differs from signed authority');
  const prefix = `/repos/${authority.repositoryName}`, api = boundaries.qualityApi ?? githubApi;
  check((await api(`${prefix}/git/ref/heads/main`)).object?.sha === authority.head, 'Release source is no longer current main');
  const pulls = evidence.transcript.flatMap(item => item.path.startsWith(`${prefix}/commits/${authority.head}/pulls?`) ? item.response : []);
  const pull = pulls.find(item => item.number === evidence.result.pullRequest);
  check(pull?.head?.sha && pull.merge_commit_sha === authority.head, 'Original reviewed source evidence differs');
  await requireReviewedHead({ sha: pull.head.sha, pullRequest: pull.number }, api);
  const run = await api(`${prefix}/actions/runs/${authority.quality.runId}`);
  check(run.id === authority.quality.runId && run.run_attempt === authority.quality.attempt && run.head_sha === authority.head &&
    run.status === 'completed' && run.conclusion === 'success', 'Current source qualification attempt changed');
  const listing = evidence.transcript.find(item => item.path.includes('/runs?branch=main&event=push&head_sha='));
  check(listing, 'Exact source qualification workflow listing required');
  const latest = (await api(listing.path)).workflow_runs;
  check(Array.isArray(latest) && latest.length > 0 && latest.filter(item => item.head_sha === authority.head && item.workflow_id === run.workflow_id && item.path === run.path)
    .sort((a, b) => b.id - a.id)[0]?.id === run.id, 'A newer source qualification attempt requires fresh admission');
}

export async function hostedController(options, boundaries = {}) {
  if (options.command === 'recover-report') return hostedReporting(options, boundaries);
  if ((options.command ?? 'plan') === 'plan') {
    const admitted = await admitHostedInvocation(options), { admission, authority } = admitted;
    return { schema: 'shop.hosted-plan/v1', scope: 'isolated-qualification', phase: 'plan-admitted',
      compositionDigest: admission.compositionDigest, authorityDigest: admission.hostedAuthority.authorityDigest,
      portableManifestDigest: admitted.portable.manifestSha256, providerWrites: 0, operationalApproval: false,
      readiness: { awsImageQualified: authority.portableManifests.every(item => item.component !== 'native' || item.awsImageQualified),
        credentialCustodyRequired: true, realProviderQualificationRequired: true } };
  }
  return withHostedReleaseSession(options, boundaries, step => step(options.command));
}

// The callback receives one transition port backed by the same admitted private
// bytes, client and exclusive writer. The port expires when the callback exits.
// A new process always copies and authenticates every subject again.
export async function withHostedReleaseSession(originalOptions, boundaries, work) {
  check(typeof work === 'function', 'Explicit release session callback required');
  originalOptions = { ...originalOptions, env: { ...(originalOptions.env ?? process.env) } };
  boundaries = { ...boundaries };
  const initialRoot = await readInstalledRoot(originalOptions.trustRoot, originalOptions.rootDigest);
  const initialAuthority = verifyHostedAuthority(parseJSON(await readRegularFile(originalOptions.authority, 16 * 1024 * 1024, true)),
    { root: initialRoot, identity: actionsIdentity(originalOptions.env ?? process.env) }).payload;
  assertOperation(initialAuthority, originalOptions.command ?? 'advance');
  const snapshot = await snapshotRelease(originalOptions), options = { ...snapshot.options, env: { ...(originalOptions.env ?? process.env) } };
  const cost = { schema: 'shop.release-session-cost/v1', startedAt: Date.now(), snapshot: snapshot.measurements,
    immutableAdmissions: 0, transitions: 0, sourceRevalidations: 0, callbackCompleted: false };
  let transport, writer, failure;
  try {
    const admitted = await admitHostedInvocation(options), { admission, authority, plan, policy } = admitted;
    cost.immutableAdmissions = 1;
    const authorityEnvelope = parseJSON(await readRegularFile(options.authority, 16 * 1024 * 1024, true));
    const sourceEvidence = options.sourceEvidence ? parseJSON(await readRegularFile(options.sourceEvidence, 32 * 1024 * 1024, true), 32 * 1024 * 1024) : null;
    let proofExpiresAt = Infinity;
    if (!authority.recovery) for (const component of admission.payload.components) for (const reference of component.componentProofs) {
      const proof = parseJSON(await readRef(options.bundle, reference)); proofExpiresAt = Math.min(proofExpiresAt, proof.expiresAt);
    }
    await snapshot.seal();
    const currentAuthority = async command => {
      check(['begin', 'advance', 'rollback'].includes(command), 'Unsupported release session transition');
      const root = await readInstalledRoot(originalOptions.trustRoot, originalOptions.rootDigest);
      const verified = verifyHostedAuthority(authorityEnvelope, { root, identity: actionsIdentity(options.env) });
      check(verified.authorityDigest === admission.hostedAuthority.authorityDigest && Date.now() < proofExpiresAt, 'Release session proof expired or authority changed');
      assertOperation(authority, command);
    };
    const fresh = async command => {
      await currentAuthority(command);
      cost.sourceRevalidations++;
      await revalidateSource(options, authority, boundaries, sourceEvidence);
    };
    await fresh(originalOptions.command ?? 'advance');
    check(typeof options.fence === 'string' && typeof options.evidenceDirectory === 'string', 'Explicit installed custody receipt and private evidence destination required');
    const fenceBytes = await readRegularFile(options.fence, 65536, true);
    check(fenceBytes.length <= 65536 && sha256(fenceBytes) === authority.writerFenceDigest, 'Independently admitted credential custody receipt differs');
    const installedBroker = admission.root.credentialBroker;
    const fence = admitCredentialFence(parseJSON(fenceBytes, 65536), { keys: installedBroker.keys, policy,
      environmentId: installedBroker.environmentId, brokerId: installedBroker.id, implementationDigest: installedBroker.implementationDigest });
    const load = retainedCandidateLoader({ bundle: options.bundle, targets: plan.targets, ...(policy.nativeQualification ? { nativeQualification: { root: admission.root, receipts: authority.nativeQualifications ?? [], qualificationPolicy: policy.nativeQualification, environmentId: admission.root.credentialBroker.environmentId, policyDigest: digest(policy.nativeQualification), secretVersionsDigest: digest(authority.secretInstallations) } } : {}) });
    const release = { head: authority.head, compositionDigest: admission.compositionDigest };
    const preflight = await preflightHostedTargets({ policy, components: admission.payload.components, targets: plan.targets, load, release });
    await retainHostedRequestGraph({ directory: options.evidenceDirectory, preflight });
    transport = boundaries.broker ?? createBrokerTransport({ root: admission.root,
      tokenProvider: () => requestBrokerIdentity({ root: admission.root, env: options.env ?? process.env }) });
    const broker = credentialBrokerBoundary({ fenceAdmission: fence, boundary: transport });
    const initialCommand = originalOptions.command ?? 'advance'; let activeCommand = initialCommand;
    writer = createHostedWriter({ policy, broker, fenceAdmission: fence, eventCacheDirectory: join(options.evidenceDirectory, 'immutable-journal-cache'),
      beforeMutation: () => currentAuthority(activeCommand) });
    const provider = createHostedProvider({ policy, writer, broker, components: admission.payload.components, targets: plan.targets,
      load, deploymentId: plan.deploymentId, release, preflight, nativeServingAuthority: authorityEnvelope,
      workInventory: () => broker.workInventory() });

    const preflightOperation = async command => {
      if (command === 'advance' && authority.operationAuthorization && !authority.operationAuthorization.commands.includes('begin')) {
        const baseline = await writer.readHead();
        check(baseline?.state.compositionDigest === admission.compositionDigest && same(baseline.state.desired, admission.payload), 'Advance-only authority requires its existing admitted release');
      }
      if (command === 'begin' || command === 'rollback') {
        const baseline = await writer.readHead(), inventory = await provider.inventory();
        compatible(admission.payload, baseline?.state.lastVerified ?? null, inventory);
        check(same([...inventory.active].sort((a, b) => a.component.localeCompare(b.component)),
          (baseline?.state.lastVerified?.components ?? []).map(selectedVersion).sort((a, b) => a.component.localeCompare(b.component))),
        'Existing active resources require independently audited adoption');
      }
    };
    await preflightOperation(activeCommand);
    let active = true, running = false, transitions = 0;
    const step = async command => {
      check(active && !running, 'Release session is closed or already advancing'); running = true;
      try {
      check(transitions === 0 ? command === initialCommand : command === 'advance', 'Release session permits its initial operation and forward continuations');
      activeCommand = command;
      await fresh(command);
      const result = await advanceWithPorts({ ...options, directory: options.evidenceDirectory, origin: plan.journeyOrigin, command }, {
        admit: async () => admission,
        withWriter: work => writer.withWriter(async session => {
          if (authority.recovery) {
            const verified = await writer.readVerification(authority.recovery.verifiedEventDigest);
            check(session.initial && (digest(session.initial.lastVerified) === authority.recovery.parentCompositionDigest &&
              session.initial.desired.rollbackCompositionDigest === admission.compositionDigest || session.initial.compositionDigest === admission.compositionDigest &&
              same(session.initial.desired, admission.payload) && session.initial.history.some(item => digest(item) === authority.recovery.parentCompositionDigest)) && same(verified.lastVerified, admission.payload) &&
              verified.verification.verifiedAt === authority.recovery.verifiedAt, 'Historical recovery journal subject changed');
          }
          return work(session);
        }), readHead: writer.readHead,readSendCheckpoint:writer.readSendCheckpoint, provider: { ...provider, write: async (...args) => { await fresh(command); return provider.write(...args); } },
        stageRequest: provider.stageRequest, verifyContent: provider.verifyContent, verificationRef: writer.verificationRef,
        journey: boundaries.journey ?? journey,
        context: { id: `protected-policy:${digest(policy)}`, scope: 'isolated-qualification', stateSchema: 'shop.hosted-release/v1',
          verificationSchema: 'shop.hosted-verification/v1', budgetScope: 'accepted-source-to-isolated-verification',
          startedAt: authority.acceptedAt, verificationEvent: true }
      });
      transitions++; cost.transitions = transitions; return structuredClone(result);
      } finally { running = false; }
    };
    try {
      const result = await writer.withSession(async () => work(step, () => ({ snapshot: snapshot.measurements, immutableAdmissions: 1, transitions,
        brokerTransport: transport.measurements?.() ?? null })));
      cost.callbackCompleted = true; return result;
    } finally { active = false; }
  } catch (error) { failure = error; throw error;
  } finally {
    if (!boundaries.broker) transport?.close?.();
    try {
      const entry = await lstat(options.evidenceDirectory);
      check(entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o777) === 0o700 && await realpath(options.evidenceDirectory) === options.evidenceDirectory,
        'Private session measurement destination changed');
      await writeFile(join(options.evidenceDirectory, `session-cost-${randomUUID()}.private.json`), canonical({ ...cost, elapsedMs: Date.now() - cost.startedAt,
        brokerTransport: transport?.measurements?.() ?? null, immutableJournal: await writer?.cacheMeasurements() ?? null }), { flag: 'wx', mode: 0o600 });
    } catch (error) { if (!failure) throw error;
    } finally { try { await snapshot.close(); } catch (error) { if (!failure) throw error; } }
  }
}

function assertOperation(authority, command) {
  if (authority.operationAuthorization) check(authority.operationAuthorization.commands.includes(command) && authority.operationAuthorization.expiresAt > Date.now(), 'Signed installed operation authority does not admit this command');
  if (authority.operationAuthorization && ['begin', 'rollback'].includes(command)) check(authority.operationAuthorization.commands.includes('advance'), 'Signed installed operation requires continuation authority');
  check(!authority.recovery || ['rollback', 'advance'].includes(command), 'Historical authority permits only its exact rollback and continuation');
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    bundle: { type: 'string' }, portable: { type: 'string' }, manifest: { type: 'string' }, authority: { type: 'string' },
    root: { type: 'string' }, 'root-digest': { type: 'string' }, 'target-plan': { type: 'string' }, fence: { type: 'string' }, evidence: { type: 'string' }
  } });
  check(positionals.length <= 1 && values.authority && values.root && values['root-digest'] &&
    (positionals[0] === 'recover-report' ? values.fence : values.bundle && values.portable && values.manifest && values['target-plan']), 'Provide the sealed artifact, composition and protected authority paths');
  return hostedController({ command: positionals[0] ?? 'plan', ...(values.bundle ? { bundle: resolve(values.bundle) } : {}), ...(values.portable ? { portable: resolve(values.portable) } : {}), ...(values.manifest ? { manifest: resolve(values.manifest) } : {}),
    authority: resolve(values.authority), trustRoot: resolve(values.root), rootDigest: values['root-digest'], ...(values['target-plan'] ? { targetPlan: resolve(values['target-plan']) } : {}),
    ...(values.fence ? { fence: resolve(values.fence) } : {}), ...(values.evidence ? { evidenceDirectory: resolve(values.evidence) } : {}) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(`${canonical({ phase: result.phase, generation: result.generation ?? null,
    compositionDigest: result.compositionDigest, waiting: result.waiting ?? null, budget: result.budget ?? null, readiness: result.readiness ?? null })}\n`))
    .catch(async error => {
      const at = process.argv.indexOf('--evidence');
      try {
        const record = await saveHostedFailure(error, at >= 0 ? process.argv[at + 1] : process.env.SHOP_HOSTED_EVIDENCE_DIRECTORY);
        process.stderr.write(`Hosted qualification failed. Private diagnostic ${record.sha256}. Reconcile before another write.\n`);
      } catch { process.stderr.write('Hosted qualification failed; the private diagnostic destination was unavailable. Preserve runner output and reconcile before another write.\n'); }
      process.exitCode = 1;
    });
}
