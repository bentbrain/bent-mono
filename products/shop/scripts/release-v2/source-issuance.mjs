import { resolveServingPlan, assertServingPlanAuthority, materializeServingConfig } from './serving-plan.mjs';
import { sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { requireReleaseChecks } from '../../../../scripts/require-release-checks.mjs';
import { canonical, check, digest, parseJSON, pathName, readRef, readRegularFile, same, sha256 } from './data.mjs';
import { activationOrder, admitComposition, admitPreviouslyVerifiedComposition, allInputs, conforms, subject } from './composition.mjs';
import { verifyHostedAuthority } from './hosted-admission.mjs';
import { materializePortableBundle, verifyPortableBundle } from './portable-bundle.mjs';
import { assertHostedPortableImport } from './artifact-intake.mjs';
import { assertProtectedInstallation, installedSigningKey, refreshProtectedInstallation, requireInstalledOperation } from './protected-installation.mjs';
import { admitCredentialFence, createHostedWriter, credentialBrokerBoundary } from './hosted-writer.mjs';
import { preflightHostedTargets, retainedCandidateLoader, retainHostedRequestGraph } from './hosted-provider.mjs';
import { createBrokerTransport, requestBrokerIdentity } from './broker-transport.mjs';
import { admitNativeBootstrap, assertNativeQualificationResult, materializeNativeQualificationPlan, nativeBootstrapSubject,
  preflightNativeQualification, runNativeQualification } from './native-qualification.mjs';

const guardPath = new URL('../../../../scripts/require-release-checks.mjs', import.meta.url);
const prefix = '/repos/bentbrain/bent-mono';
const sourceAdmissions = new WeakMap(), assemblies = new WeakMap();
const validTime = (value, label) => check(Number.isSafeInteger(value) && value > 0, `Exact ${label} time required`);
const clone = value => structuredClone(value);
const deliveryTiming = (acceptedAt, observedAt, budgetMs, deliveryRequestedAt = null) => ({ acceptedAt, observedAt, elapsedMs: observedAt - acceptedAt, budgetMs,
  exceeded: observedAt - acceptedAt >= budgetMs, deliveryRequestedAt, measuredElapsedMs: deliveryRequestedAt === null ? null : observedAt - deliveryRequestedAt,
  measuredBudgetExceeded: deliveryRequestedAt === null ? null : observedAt - deliveryRequestedAt >= budgetMs,
  automationTimingAvailable: deliveryRequestedAt !== null, productionDeliveryMeasured: false });

function identityMatches(root, identity) {
  check(identity && same(identity.repository, root.repository) && identity.repositoryName === root.repositoryName &&
    identity.workflowCommit === identity.head && identity.workflowRef === `${root.repositoryName}/${root.workflowPath}@refs/heads/main` &&
    /^[a-f0-9]{40}$/.test(identity.head) && Number.isSafeInteger(identity.runId) && identity.runId > 0 &&
    Number.isSafeInteger(identity.attempt) && identity.attempt > 0, 'Source issuance invocation differs from installation');
}

/** Retain the actual canonical release guard result and its read-only evidence. */
export async function qualifyHostedSource({ installation, identity, qualityApi, acceptedAt, now = Date.now }) {
  assertProtectedInstallation(installation);
  check(typeof qualityApi === 'function' && typeof now === 'function', 'Explicit authenticated source API and clock required');
  const started = now(); validTime(started, 'source qualification');
  const current = await refreshProtectedInstallation(installation, started), { root, template } = current;
  identityMatches(root, identity);
  const transcript = []; let transcriptBytes = 0;
  const read = async path => {
    check(typeof path === 'string' && (path === prefix || path.startsWith(`${prefix}/`)) && path.length <= 2048 && !/[\x00-\x20\x7f#]/.test(path) && transcript.length < 512,
      'Bounded canonical read-only source API path required');
    const bytes = Buffer.from(canonical(await qualityApi(path)));
    transcriptBytes += bytes.length;
    check(bytes.length <= 16 * 1024 * 1024 && transcriptBytes <= 32 * 1024 * 1024, 'Bounded source API response and aggregate transcript required');
    const captured = parseJSON(bytes, 16 * 1024 * 1024); transcript.push({ path, response: captured }); return clone(captured);
  };
  const repository = await read(prefix);
  check(repository.id === root.repository.repositoryId && repository.owner?.id === root.repository.ownerId && repository.full_name === root.repositoryName,
    'Canonical repository immutable identity differs');
  const commit = await read(`${prefix}/git/commits/${identity.head}`);
  check(commit.sha === identity.head && /^[a-f0-9]{40}$/.test(commit.tree?.sha ?? '') && Array.isArray(commit.parents) &&
    commit.parents.length > 0 && /^[a-f0-9]{40}$/.test(commit.parents[0].sha), 'Canonical source tree or base differs');
  const workflow = await read(`${prefix}/actions/workflows/${root.workflowPath.split('/').at(-1)}`);
  check(workflow.path === root.workflowPath && workflow.state === 'active' && Number.isSafeInteger(workflow.id) && workflow.id > 0,
    'Canonical executing workflow differs');
  const verifyInvocation = run => check(run.id === identity.runId && run.run_attempt === identity.attempt && run.workflow_id === workflow.id &&
    run.head_sha === identity.head && run.head_branch === 'main' && run.event === 'workflow_dispatch' && run.path === root.workflowPath &&
    run.repository?.id === root.repository.repositoryId && run.head_repository?.id === root.repository.repositoryId &&
    run.repository?.full_name === root.repositoryName && run.head_repository?.full_name === root.repositoryName &&
    ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status), 'Canonical current source invocation differs');
  const runPath = `${prefix}/actions/runs/${identity.runId}`;
  verifyInvocation(await read(runPath));
  await refreshProtectedInstallation(current, now());
  const admittedGuardDigest = sha256(await readFile(guardPath));
  const quality = await requireReleaseChecks(identity.head, read);
  verifyInvocation(await read(runPath));
  const pull = transcript.flatMap(item => item.path.startsWith(`${prefix}/commits/${identity.head}/pulls?`) ? item.response : [])
    .find(item => item.number === quality.pullRequest);
  const originalAcceptedAt = Date.parse(pull?.merged_at);
  validTime(originalAcceptedAt, 'canonical source acceptance');
  check(acceptedAt === undefined || acceptedAt === originalAcceptedAt, 'Accepted source time differs from canonical merged pull request');
  let deliveryRequestedAt = null;
  try {
    const requests = [];
    for (let page = 1; page <= 20; page++) {
      const result = await read(`${prefix}/actions/runs?head_sha=${pull.head.sha}&per_page=100&page=${page}`);
      check(Array.isArray(result.workflow_runs) && result.workflow_runs.length <= 100, 'Complete reviewed source automation requests required');
      for (const run of result.workflow_runs) {
        check(run.head_sha === pull.head.sha && run.repository?.id === root.repository.repositoryId && run.repository?.full_name === root.repositoryName &&
          run.head_repository?.id === root.repository.repositoryId && run.head_repository?.full_name === root.repositoryName, 'Automation request source identity differs');
        const createdAt = Date.parse(run.created_at); validTime(createdAt, 'automation request'); check(createdAt <= now(), 'Automation request is in the future'); requests.push(createdAt);
      }
      if (result.workflow_runs.length < 100) { check(requests.length > 0, 'Reviewed source automation request metadata missing'); deliveryRequestedAt = Math.min(...requests); break; }
    }
  } catch { deliveryRequestedAt = null; }
  const completedAt = now(); validTime(completedAt, 'source qualification');
  check(completedAt >= started && originalAcceptedAt <= started, 'Canonical source acceptance or qualification clock differs');
  const guardImplementationSha256 = sha256(await readFile(guardPath));
  check(guardImplementationSha256 === admittedGuardDigest, 'Canonical source guard implementation changed during qualification');
  const evidence = { schema: 'shop.source-issuance-evidence/v1', repository: root.repository, source: identity.head,
    acceptedAt: originalAcceptedAt, startedAt: started, completedAt, guardImplementationSha256,
    timing: deliveryTiming(originalAcceptedAt, completedAt, template.budgetMs, deliveryRequestedAt), result: quality, transcript: clone(transcript) };
  const admission = { identity: clone(identity), base: commit.parents[0].sha, tree: commit.tree.sha, quality, acceptedAt: originalAcceptedAt, evidence };
  sourceAdmissions.set(admission, { admissionDigest: digest(admission), installationDigest: digest(current.contract), read, verifyInvocation, runPath, identityDigest: digest(identity) });
  return admission;
}

function assertSource(admission, installation, identity) {
  const state = sourceAdmissions.get(admission);
  check(state && state.admissionDigest === digest(admission) && state.installationDigest === digest(installation.contract) && state.identityDigest === digest(identity), 'Actual exact-source release qualification required');
  return state;
}

async function put(root, path, value) {
  pathName(path); const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value));
  await mkdir(dirname(join(root, path)), { mode: 0o700, recursive: true });
  await writeFile(join(root, path), bytes, { mode: 0o600, flag: 'wx' });
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

function sourcePolicy(installation, portable, source) {
  const { contracts, dependencies, schemaState, ...template } = clone(installation.template);
  check(portable.manifest.originSourceCommit === source.identity.head, 'Portable intent differs from accepted canonical source');
  check(same(portable.closurePolicy, template.closurePolicy), 'Portable runtime or reviewed source closure policy differs');
  const policy = { ...template, schema: 'shop.hosted-composition-policy/v1', intentCommits: [source.identity.head], baseCommit: source.base,
    inputPaths: [...new Set([...portable.snapshots.values()].flatMap(snapshot => snapshot.files.map(file => file.path)))].sort(),
    snapshots: [...portable.snapshots.values()].map(snapshot => ({ commit: snapshot.originSourceCommit, root: snapshot.root,
      files: snapshot.files, treeDigest: snapshot.treeDigest })) };
  conforms(policy, 'hostedTrust'); return policy;
}

function nativeQualificationContext(installation, receipts = []) {
  check(Array.isArray(receipts) && receipts.length <= 1, 'One exact native qualification receipt is supported');
  if (!installation.providerPolicy.nativeQualification) {
    check(receipts.length === 0, 'Native qualification receipt requires installed policy');
    return undefined;
  }
  return { root: installation.root, receipts, environmentId: installation.root.credentialBroker.environmentId,
    policyDigest: digest(installation.providerPolicy.nativeQualification), qualificationPolicy: installation.providerPolicy.nativeQualification,
    secretVersionsDigest: digest(installation.secretInstallations) };
}

async function checkNativeReceipts(installation, payload, bundle, receipts, plan = installation.plan) {
  const nativeQualification = nativeQualificationContext(installation, receipts);
  if (!receipts.length) return;
  const component = payload.components.find(item => item.id === 'native');
  check(component, 'Native qualification requires its exact component');
  const candidate = await retainedCandidateLoader({ bundle, targets: plan.targets, nativeQualification })(component);
  check(candidate.native?.awsImageQualified === true, 'Actual native provider qualification is required');
}

async function nativeBootstrapWorker(current, portable, plan, evidencePath) {
  if (!plan.bootstrapWorker) return undefined;
  const { target } = plan.bootstrapWorker, business = portable.components.get('business');
  check(business && target?.kind === 'worker' && target.component === 'business' &&
    !current.plan.targets.some(item => item.kind === 'worker' && item.resource === target.resource),
  'Bootstrap business Worker must be separate from all serving Workers');
  const installed = current.contract.componentConfigurations.find(item => item.component === 'business');
  check(installed, 'Installed business configuration is required for native bootstrap');
  const configBytes = await readRegularFile(installed.config.path, 16 * 1024 * 1024, true);
  check(sha256(configBytes) === installed.config.sha256, 'Installed bootstrap business configuration changed');
  const directory = await mkdtemp(join(dirname(evidencePath), 'native-business-'));
  for (const reference of [business.artifactRef, business.provenanceRef, ...business.artifact.files])
    await put(directory, reference.path, await readRef(portable.root, reference));
  const component = { ...clone(business.component), config: await put(directory, 'release-bindings/business.json', configBytes) };
  const load = retainedCandidateLoader({ bundle: directory, targets: [target] });
  await load(component);
  return { component, target, load };
}

async function installedReader({ installation, payload, bundle, env, boundaries, now, evidenceDirectory, release, nativeQualificationReceipts = [], resolvedPlan = installation.plan }) {
  // Validate all retained target bytes before obtaining even a read-only broker identity.
  const preflight = await preflightHostedTargets({ policy: installation.providerPolicy, components: payload.components, targets: resolvedPlan.targets,
    load: retainedCandidateLoader({ bundle, targets: resolvedPlan.targets,
      nativeQualification: nativeQualificationContext(installation, nativeQualificationReceipts) }), release });
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await retainHostedRequestGraph({ directory: evidenceDirectory, preflight });
  const fenceBytes = await readRegularFile(installation.fencePath, 65536, true);
  check(sha256(fenceBytes) === installation.fenceDigest, 'Installed baseline credential fence bytes differ');
  const fence = admitCredentialFence(parseJSON(fenceBytes), {
    keys: installation.root.credentialBroker.keys, policy: installation.providerPolicy, environmentId: installation.root.credentialBroker.environmentId,
    brokerId: installation.root.credentialBroker.id, implementationDigest: installation.root.credentialBroker.implementationDigest, now: now() });
  const boundary = boundaries.broker ?? createBrokerTransport({ root: installation.root,
    tokenProvider: () => requestBrokerIdentity({ root: installation.root, env }) });
  const broker = credentialBrokerBoundary({ fenceAdmission: fence, boundary, now });
  const writer = createHostedWriter({ policy: installation.providerPolicy, broker, fenceAdmission: fence,
    eventCacheDirectory: join(evidenceDirectory, 'immutable-journal-cache') });
  return writer;
}

async function installedBaseline(args) {
  const { installation, command } = args;
  check(['plan', 'advance', 'begin'].includes(command), 'Historical rollback requires its separately admitted verified composition');
  if (command === 'plan') return { observed: false, parentCompositionDigest: null, rollbackCompositionDigest: null };
  const writer = await installedReader(args);
  const observed = await writer.readHead();
  if (!observed) return { observed: true, head: null, parentCompositionDigest: null, rollbackCompositionDigest: null };
  const state = observed.state, context = `protected-policy:${digest(installation.providerPolicy)}`;
  check(state.schema === 'shop.hosted-release/v1' && state.providerOrigin === context && ['complete', 'reporting-pending', 'report-intent', 'report-reconcile'].includes(state.phase) && (!state.operation || state.operation.kind === 'reports') &&
    state.lastVerified && state.desired && same(state.lastVerified, state.desired) && digest(state.lastVerified) === state.compositionDigest &&
    state.policyDigest === state.lastVerified.policyDigest && ['pending', 'confirmed'].includes(state.report?.status) && state.verification &&
    state.verification.schema === 'shop.hosted-verification/v1' && state.verification.scope === installation.root.scope &&
    state.verification.compositionDigest === state.compositionDigest && state.report.verificationDigest === digest(state.verification) &&
    Array.isArray(state.history) && state.history.some(item => same(item, state.lastVerified)), 'Existing protected release has unresolved or invalid verified state');
  conforms(state.lastVerified, 'hostedPayload');
  check(same(state.lastVerified.repository, installation.root.repository) && command === 'begin', 'Use begin for a subsequent verified release');
  const verified = await writer.readVerification(state.report.eventDigest);
  check(same(verified.lastVerified, state.lastVerified) && same(verified.verification, state.verification), 'Protected baseline lacks its exact immutable runtime verification');
  const final = await writer.readHead();
  check(same(final, observed), 'Protected baseline changed before composition signing');
  return { observed: true, head: observed.head, verificationEventDigest: state.report.eventDigest,
    parentCompositionDigest: digest(state.lastVerified), rollbackCompositionDigest: digest(state.lastVerified) };
}

/** This signer accepts the exact payload prepared by the authenticated assembler. */
async function signInstalledComposition({ installation, payload, sourceAdmission, identity, now = Date.now() }) {
  assertProtectedInstallation(installation); assertSource(sourceAdmission, installation, identity);
  const prepared = assemblies.get(payload);
  check(prepared && prepared.installationDigest === digest(installation.contract) && prepared.payloadDigest === digest(payload), 'Authenticated composition assembly required before signing');
  conforms(payload, 'hostedPayload');
  const current = await refreshProtectedInstallation(installation, now);
  assertSource(sourceAdmission, current, identity);
  check(prepared.payloadDigest === digest(payload), 'Composition changed during signing admission');
  const key = await installedSigningKey(current, 'composition');
  return { payload, signature: { payloadType: payload.schema, payloadDigest: digest(payload), keyId: key.keyId,
    algorithm: 'ECDSA_SHA_256', signer: 'protected-ci', signature: sign('sha256', Buffer.from(canonical(payload)), key.privateKey).toString('base64') } };
}

async function installedOperationAuthorization(installation, command, now) {
  if (command === 'plan') return { scopeDigest: installation.contract.operationScope?.sha256 ?? null, commands: [], expiresAt: now + installation.root.maximumLifetimeMs };
  await requireInstalledOperation(installation, command, now);
  check(['advance', 'begin', 'deliver', 'rollback'].includes(command), 'Composition operation required');
  return { scopeDigest: installation.contract.operationScope.sha256,
    commands: installation.operationScope.commands.filter(value => ['advance', 'begin', 'deliver', 'rollback'].includes(value)),
    expiresAt: installation.operationScope.expiresAt };
}

/** Prepare isolated native qualification from authenticated OCI bytes and installed policy. */
export async function prepareHostedNativeQualification({ installation, identity, imported, qualityApi, acceptedAt, now = Date.now,
  executionScope = installation.providerPolicy.nativeQualification?.executionScope ?? 'aws/provider' }) {
  assertProtectedInstallation(installation); check(typeof now === 'function', 'Explicit native qualification clock required');
  check(['aws/provider', 'fixture/provider-loopback'].includes(executionScope) &&
    !(installation.providerPolicy.nativeQualification?.executionScope === 'fixture/provider-loopback' && executionScope !== 'fixture/provider-loopback'),
  'Installed fixture qualification cannot issue an AWS qualification');
  await requireInstalledOperation(installation, 'native-bootstrap', now());
  const authenticated = await assertHostedPortableImport(imported, { installation: installation.artifactIntake, sourceCommit: identity.head });
  const current = await refreshProtectedInstallation(installation, now(), [authenticated.portable.root, dirname(authenticated.evidence.path)]);
  identityMatches(current.root, identity);
  const source = await qualifyHostedSource({ installation: current, identity, qualityApi, acceptedAt, now });
  const state = assertSource(source, current, identity), portable = await verifyPortableBundle(authenticated.portable.root, authenticated.portable.expected);
  check(portable.manifest.originSourceCommit === identity.head, 'Native qualification source differs from canonical workflow source');
  const native = portable.components.get('native');
  check(native && native.artifact.format === 'oci-layout' && current.nativeQualificationPlan,
    'Installed native qualification source or plan is missing');
  check(executionScope === 'fixture/provider-loopback' || native.runtime.definition.kind === 'linux-native-oci-candidate' &&
    native.runtime.definition.nativeOciReceipt?.schema === 'shop.native-v5-oci-receipt/v1',
    'Real native qualification requires the complete verified OCI producer receipt');
  const qualificationRuntime = native.runtime.definition.kind === 'linux-native-oci-candidate' ? native.runtime : null;
  const plan = await materializeNativeQualificationPlan({ template: current.nativeQualificationPlan,
    policy: current.providerPolicy, artifact: native.artifact, runtime: qualificationRuntime, component: native.component,
    readFile: reference => readRef(portable.root, reference), secretVersionsDigest: digest(current.secretInstallations), invocation: identity });
  const serving = current.plan.targets.filter(target => target.kind === 'lambda').map(target => target.resource);
  check(current.providerPolicy.nativeQualification.resources.every(resource => !serving.includes(resource.name)),
    'Native qualification resources must be separate from serving functions');
  const bootstrapWorker = await nativeBootstrapWorker(current, portable, plan, authenticated.evidence.path);
  const preflight = await preflightNativeQualification({ policy: current.providerPolicy, artifact: native.artifact,
    component: native.component, runtime: qualificationRuntime, plan, bootstrapWorker, readFile: reference => readRef(portable.root, reference) });
  const subject = nativeBootstrapSubject(preflight);
  check(subject.sourceDigest === native.component.codeDigest && subject.secretVersionsDigest === digest(current.secretInstallations),
    'Native qualification request graph subject differs');
  const revalidateInstallation = async () => {
    const at = now(), fresh = await refreshProtectedInstallation(current, at);
    assertSource(source, fresh, identity); await requireInstalledOperation(fresh, 'native-bootstrap', at);
    return fresh;
  };
  const revalidate = async () => {
    const fresh = await revalidateInstallation();
    state.verifyInvocation(await state.read(state.runPath));
    await requireReleaseChecks(identity.head, state.read);
    check((await state.read(`${prefix}/git/ref/heads/main`)).object?.sha === identity.head,
      'Canonical source changed before native qualification');
    return fresh;
  };
  const fresh = await revalidate(), issuedAt = now(), operation = await requireInstalledOperation(fresh, 'native-bootstrap', issuedAt);
  const payload = { schema: 'shop.native-bootstrap-authority/v1', operation: 'native-bootstrap', scope: 'isolated-native-qualification',
    invocation: clone(identity), sourceEvidenceDigest: digest(source.evidence),
    environmentId: fresh.root.credentialBroker.environmentId, policyDigest: digest(fresh.providerPolicy), writerFenceDigest: fresh.fenceDigest,
    sourceDigest: subject.sourceDigest, imageDigest: subject.imageDigest, recipeDigest: subject.recipeDigest,
    secretVersionsDigest: subject.secretVersionsDigest, planDigest: subject.planDigest, requestGraphDigest: subject.requestGraphDigest,
    executionScope, issuedAt, expiresAt: Math.min(issuedAt + fresh.root.maximumLifetimeMs, operation.expiresAt) };
  const key = await installedSigningKey(fresh, 'source');
  const authority = { payload, signature: { algorithm: 'ECDSA_SHA_256', keyId: key.keyId, payloadDigest: digest(payload),
    signature: sign('sha256', Buffer.from(canonical(payload)), key.privateKey).toString('base64') } };
  const admission = admitNativeBootstrap(authority, { root: fresh.root, policy: fresh.providerPolicy, fenceDigest: fresh.fenceDigest,
    sourceDigest: subject.sourceDigest, identity, executionScope, now: issuedAt });
  return { installation: fresh, identity, preflight, admission, authority, sourceEvidence: source.evidence, revalidate, revalidateInstallation };
}

/** Qualify one isolated OCI candidate through the default protected credential owner. */
export async function executeHostedNativeQualification({ installation, identity, imported, evidenceDirectory, qualityApi, acceptedAt,
  env = process.env, boundaries = {}, now = Date.now }) {
  const executionScope = boundaries.broker || installation.providerPolicy.nativeQualification?.executionScope === 'fixture/provider-loopback'
    ? 'fixture/provider-loopback' : 'aws/provider';
  const prepared = await prepareHostedNativeQualification({ installation, identity, imported, qualityApi, acceptedAt, now, executionScope });
  const current = prepared.installation;
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const retain = async (path, value) => {
    try { return await put(evidenceDirectory, path, value); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      check((await readRegularFile(join(evidenceDirectory, path), 16 * 1024 * 1024, true)).equals(Buffer.from(canonical(value))),
        'Retained native qualification evidence changed');
    }
  };
  await retain(`native-source-${digest(prepared.sourceEvidence)}.json`, prepared.sourceEvidence);
  await retain(`native-authority-${digest(prepared.authority)}.json`, prepared.authority);
  await retain(`native-request-graph-${prepared.preflight.digest}.json`, prepared.preflight);
  const fenceBytes = await readRegularFile(current.fencePath, 65536, true);
  check(sha256(fenceBytes) === current.fenceDigest, 'Installed native credential fence bytes differ');
  const fenceAdmission = admitCredentialFence(parseJSON(fenceBytes), { keys: current.root.credentialBroker.keys,
    policy: current.providerPolicy, environmentId: current.root.credentialBroker.environmentId, brokerId: current.root.credentialBroker.id,
    implementationDigest: current.root.credentialBroker.implementationDigest, now: now() });
  const boundary = boundaries.broker ?? createBrokerTransport({ root: current.root,
    tokenProvider: () => requestBrokerIdentity({ root: current.root, env }) });
  const broker = credentialBrokerBoundary({ fenceAdmission, boundary, now });
  const writer = createHostedWriter({ policy: current.providerPolicy, broker, fenceAdmission,
    journalNamespace: `native-qualification/${prepared.admission.payload.imageDigest}`,
    beforeMutation: prepared.revalidateInstallation,
    eventCacheDirectory: join(evidenceDirectory, 'immutable-native-journal-cache') });
  const attest = async payload => {
    assertNativeQualificationResult(payload, { preflight: prepared.preflight, admission: prepared.admission });
    const fresh = await prepared.revalidate(), key = await installedSigningKey(fresh, 'source');
    return { payload, signature: { algorithm: 'ECDSA_SHA_256', keyId: key.keyId, payloadDigest: digest(payload),
      signature: sign('sha256', Buffer.from(canonical(payload)), key.privateKey).toString('base64') } };
  };
  try {
    const receipt = await runNativeQualification({ ...prepared, writer, broker, attest });
    await retain(`native-qualification-${digest(receipt)}.json`, receipt);
    return { receipt, authority: prepared.authority, sourceEvidence: prepared.sourceEvidence,
      readiness: { nativeQualificationComplete: true, awsImageQualified: receipt.payload.awsImageQualified,
        executionScope: receipt.payload.scope, productionDeliveryMeasured: false } };
  } finally { if (!boundaries.broker) boundary.close(); }
}

/** Issue existing-schema authority from an admitted assembly and actual guard result. */
export async function issueHostedAuthority({ installation, identity, imported, composition, sourceAdmission, qualityApi, acceptedAt, command = 'plan', now = Date.now,
  nativeQualificationReceipts = [] }) {
  assertProtectedInstallation(installation); check(typeof now === 'function', 'Explicit source issuance clock required');
  const source = sourceAdmission ?? await qualifyHostedSource({ installation, identity, qualityApi, acceptedAt, now });
  const state = assertSource(source, installation, identity);
  const retainedImport = await assertHostedPortableImport(imported, { installation: installation.artifactIntake, sourceCommit: identity.head });
  const current = await refreshProtectedInstallation(installation, now(), [retainedImport.portable.root, dirname(retainedImport.evidence.path), composition.bundle]), { root } = current;
  identityMatches(root, identity);
  const retained = await verifyPortableBundle(retainedImport.portable.root, retainedImport.portable.expected);
  const envelope = parseJSON(await readRegularFile(composition.manifest, 16 * 1024 * 1024, true), 16 * 1024 * 1024);
  const policy = sourcePolicy(current, retained, source);
  check(envelope.payload.intentSourceCommit === identity.head && envelope.payload.policyDigest === digest(policy), 'Composition source or installed policy differs');
  const admission = await admitComposition({ ...composition, trust: policy, domain: root.scope });
  const serving = resolveServingPlan({ plan: current.plan, policy: current.providerPolicy, components: admission.payload.components,
    portable: retained, nativeQualification: nativeQualificationContext(current, nativeQualificationReceipts) });
  await checkNativeReceipts(current, admission.payload, composition.bundle, nativeQualificationReceipts, serving.plan);
  const portableManifests = [];
  for (const component of admission.payload.components) {
    const original = retained.components.get(component.id), config = current.contract.componentConfigurations.find(item => item.component === component.id);
    check(config, 'Installed component configuration required');
    const configured = await readRegularFile(config.config.path, 16 * 1024 * 1024, true);
    check(sha256(configured) === config.config.sha256, 'Installed component configuration changed before authority signing');
    const expectedConfigDigest = current.providerPolicy.nativeServing && component.id === current.providerPolicy.nativeServing.businessComponent
      ? sha256(canonical(materializeServingConfig(parseJSON(configured), current.providerPolicy, serving.authorityFields.nativeServingSelection)))
      : config.config.sha256;
    check(original && same(component.artifact, original.artifactRef) && same(component.provenance, original.provenanceRef) &&
      component.codeDigest === original.artifact.codeDigest && component.config.sha256 === expectedConfigDigest &&
      component.originSourceCommit === original.component.originSourceCommit && same(component.contract, current.template.contracts[component.id]),
    'Authority component differs from retained source or protected installation');
    const qualifications = [];
    for (const reference of component.componentProofs) if (parseJSON(await readRef(composition.bundle, reference)).kind === 'qualification') qualifications.push(reference.sha256);
    check(qualifications.length === 1, 'Exact authenticated source qualification required');
    portableManifests.push({ component: component.id, manifestSha256: retained.manifestSha256, originSourceCommit: component.originSourceCommit,
      lineageDigest: digest(retained.lineage), codeDigest: component.codeDigest, configDigest: component.config.sha256,
      runtimeDigest: original.artifact.runtimeDigest, qualificationDigest: qualifications[0], awsImageQualified: false });
  }
  state.verifyInvocation(await state.read(state.runPath));
  check((await state.read(`${prefix}/git/ref/heads/main`)).object?.sha === identity.head, 'Canonical source changed before authority signing');
  const issuedAt = now(); validTime(issuedAt, 'source issuance');
  check(issuedAt >= source.evidence.completedAt, 'Source issuance clock moved backwards');
  const final = await refreshProtectedInstallation(current, issuedAt);
  check(same(final.contract, current.contract), 'Protected installation changed during issuance');
  assertSource(source, final, identity);
  const evidence = { ...clone(source.evidence), timing: deliveryTiming(source.acceptedAt, issuedAt, policy.budgetMs, source.evidence.timing.deliveryRequestedAt) };
  const operationAuthorization = await installedOperationAuthorization(final, command, issuedAt);
  const payload = { schema: 'shop.hosted-source-authority/v3', operationAuthorization, recovery: null, scope: root.scope, repository: root.repository, repositoryName: root.repositoryName,
    environment: root.environment, head: identity.head, base: source.base, tree: source.tree, workflowPath: root.workflowPath,
    workflowCommit: identity.workflowCommit, runId: identity.runId, attempt: identity.attempt, issuedAt,
    expiresAt: Math.min(issuedAt + root.maximumLifetimeMs, operationAuthorization.expiresAt), acceptedAt: source.acceptedAt, policy,
    providerPolicyDigest: root.providerPolicyDigest, targetPlanDigest: current.contract.targetPlan.sha256, writerFenceDigest: current.fenceDigest,
    portableManifests, ...serving.authorityFields, ...(nativeQualificationReceipts.length ? { nativeQualifications: clone(nativeQualificationReceipts) } : {}), secretInstallations: current.secretInstallations,
    quality: { head: identity.head, runId: source.quality.qualityRunId, attempt: source.quality.qualityAttempt, releaseGuardDigest: digest(evidence) } };
  const key = await installedSigningKey(final, 'source');
  const authority = { payload, signature: { algorithm: 'ECDSA_SHA_256', keyId: key.keyId, payloadDigest: digest(payload),
    signature: sign('sha256', Buffer.from(canonical(payload)), key.privateKey).toString('base64') } };
  verifyHostedAuthority(authority, { root: final.root, identity, now: issuedAt });
  return { authority, evidence, quality: source.quality, acceptedAt: source.acceptedAt };
}

/** Assemble existing retained bytes and derive fresh proofs from authenticated evidence. */
export async function assembleHostedRelease({ installation, identity, imported, destination, evidenceDirectory, qualityApi, acceptedAt,
  command = 'plan', env = process.env, boundaries = {}, now = Date.now, nativeQualificationReceipts = [] }) {
  assertProtectedInstallation(installation); check(typeof now === 'function', 'Explicit assembly clock required');
  await requireInstalledOperation(installation, command, now());
  if (command === 'begin') await requireInstalledOperation(installation, 'advance', now());
  const authenticated = await assertHostedPortableImport(imported, { installation: installation.artifactIntake, sourceCommit: identity.head }), portable = authenticated.portable;
  const current = await refreshProtectedInstallation(installation, now(), [portable.root, dirname(authenticated.evidence.path), resolve(destination)]); identityMatches(current.root, identity);
  const source = await qualifyHostedSource({ installation: current, identity, qualityApi, acceptedAt, now });
  const policy = sourcePolicy(current, portable, source);
  const root = resolve(destination), assembly = await materializePortableBundle(portable, root);
  const serving = resolveServingPlan({ plan: current.plan, policy: current.providerPolicy,
    components: [...assembly.components.values()].map(item => item.component), portable,
    nativeQualification: nativeQualificationContext(current, nativeQualificationReceipts) });
  const sourceRef = await put(root, 'release-evidence/source.json', source.evidence);
  const artifactRef = await put(root, 'release-evidence/artifact.json', authenticated.evidence);
  const installationRef = await put(root, 'release-evidence/installation.json', { schema: 'shop.installed-release-evidence/v1',
    installationDigest: digest(current.contract), rootDigest: current.rootDigest, targetPlanDigest: current.contract.targetPlan.sha256,
    writerFenceDigest: current.fenceDigest, secretInstallations: current.secretInstallations });
  const runnerBytes = await readRegularFile(current.contract.runnerFile.path, 16 * 1024 * 1024, true);
  check(sha256(runnerBytes) === policy.runner.script.sha256, 'Installed runner changed before assembly');
  await put(root, policy.runner.script.path, runnerBytes);
  const createdAt = now(), payload = { schema: 'shop.release-composition/v2', repository: current.root.repository, target: current.root.scope,
    intentSourceCommit: identity.head, baseCommit: source.base, createdAt: new Date(createdAt).toISOString(), policyDigest: digest(policy),
    parentCompositionDigest: null, rollbackCompositionDigest: null, changeClass: 'compatible', schemaState: clone(current.template.schemaState),
    components: [], dependencies: clone(current.template.dependencies), proofRefs: [] };
  for (const importedComponent of assembly.components.values()) {
    const component = { ...clone(importedComponent.component), contract: clone(current.template.contracts[importedComponent.component.id]), componentProofs: [] };
    check(component.inputsDigest === component.intentInputsDigest && component.proofInputsDigest === component.intentProofInputsDigest,
      'Changed component source, dependency or proof requires fresh qualification before signing');
    const installedConfig = current.contract.componentConfigurations.find(item => item.component === component.id);
    const configBytes = await readRegularFile(installedConfig.config.path, 16 * 1024 * 1024, true);
    check(sha256(configBytes) === installedConfig.config.sha256, 'Installed component configuration changed');
    const configured = current.providerPolicy.nativeServing && component.id === current.providerPolicy.nativeServing.businessComponent
      ? Buffer.from(canonical(materializeServingConfig(parseJSON(configBytes), current.providerPolicy, serving.authorityFields.nativeServingSelection)))
      : configBytes;
    component.config = await put(root, `release-bindings/${component.id}.json`, configured);
    payload.components.push(component);
  }
  // Validate the complete unsigned component subjects before reading a signing key.
  conforms({ ...payload, components: payload.components.map(component => ({ ...component, componentProofs: [sourceRef, artifactRef] })),
    proofRefs: policy.requiredProofKinds.map(kind => ({ kind, receipt: sourceRef })) }, 'hostedPayload');
  activationOrder(payload);
  await checkNativeReceipts(current, payload, root, nativeQualificationReceipts, serving.plan);
  await installedSigningKey(current, 'source');
  const key = await installedSigningKey(current, 'composition');
  const baseline = await installedBaseline({ installation: current, payload, bundle: root, command, env, boundaries, now, evidenceDirectory,
    nativeQualificationReceipts, resolvedPlan: serving.plan, release: { head: identity.head, compositionDigest: digest(payload) } });
  payload.parentCompositionDigest = baseline.parentCompositionDigest; payload.rollbackCompositionDigest = baseline.rollbackCompositionDigest;
  const baselineRef = await put(root, 'release-evidence/baseline.json', baseline);
  for (const component of payload.components) {
    const importedComponent = assembly.components.get(component.id);
    for (const kind of ['artifact', 'qualification']) {
      const evidence = await put(root, `release-evidence/${component.id}-${kind}.json`, { schema: 'shop.retained-source-proof-evidence/v1', kind,
        source: sourceRef, artifact: artifactRef, installation: installationRef, baseline: baselineRef, component: component.id, codeDigest: component.codeDigest,
        runtimeDigest: importedComponent.artifact.runtimeDigest, awsImageQualified: false });
      const proof = { schema: 'shop.component-proof/v1', scope: current.root.scope, kind, component: component.id,
        originSourceCommit: component.originSourceCommit, codeDigest: component.codeDigest, inputsDigest: component.inputsDigest,
        proofInputsDigest: component.proofInputsDigest, runtimeDigest: importedComponent.artifact.runtimeDigest,
        bindingDigest: kind === 'qualification' ? component.config.sha256 : null, policyDigest: digest(policy.closurePolicy),
        verifierDigest: policy.implementationDigest, createdAt, expiresAt: createdAt + current.root.maximumLifetimeMs, evidence };
      component.componentProofs.push(await put(root, `release-proofs/${component.id}-${kind}.json`, { ...proof,
        signature: sign('sha256', Buffer.from(canonical(proof)), key.privateKey).toString('base64') }));
    }
  }
  for (const kind of [...policy.requiredProofKinds].sort()) {
    const receipt = await put(root, `release-proofs/composition-${kind}.json`, { schema: 'shop.hosted-receipt/v1', scope: current.root.scope, kind,
      subjectDigest: subject(payload), inputsDigest: allInputs(payload), policyDigest: payload.policyDigest, verifierDigest: policy.implementationDigest,
      evidence: kind === 'artifact' || kind === 'qualification' ? artifactRef : kind === 'owner' ? installationRef : sourceRef });
    payload.proofRefs.push({ kind, receipt });
  }
  assemblies.set(payload, { installationDigest: digest(current.contract), payloadDigest: digest(payload) });
  const envelope = await signInstalledComposition({ installation: current, payload, sourceAdmission: source, identity, now: now() });
  const manifest = join(root, 'release-composition.json'); await writeFile(manifest, canonical(envelope), { mode: 0o600, flag: 'wx' });
  const issued = await issueHostedAuthority({ installation: current, identity, imported, composition: { bundle: root, manifest }, sourceAdmission: source,
    command, now, nativeQualificationReceipts });
  const authority = join(root, 'release-authority.json'); await writeFile(authority, canonical(issued.authority), { mode: 0o600, flag: 'wx' });
  await put(root, 'release-evidence/authority-issuance.json', issued.evidence);
  return { options: { bundle: root, portable: portable.root, manifest, authority, trustRoot: current.rootPath, rootDigest: current.rootDigest,
    targetPlan: current.planPath, fence: current.fencePath, evidenceDirectory, sourceEvidence: join(root, 'release-evidence/authority-issuance.json') }, ...issued,
    baseline, readiness: { operationalApproval: false, awsImageQualified: false, realProviderQualificationRequired: true, providerWrites: 0,
      baselineObserved: baseline.observed, timing: issued.evidence.timing } };
}


/** Fresh canonical source authorizes one exact previously verified rollback. */
export async function assembleHostedRollback({ installation, identity, rollbackDirectory, evidenceDirectory, qualityApi, acceptedAt, env = process.env, boundaries = {}, now = Date.now }) {
  assertProtectedInstallation(installation);
  for (const command of ['rollback', 'advance']) await requireInstalledOperation(installation, command, now());
  const current = await refreshProtectedInstallation(installation, now()); identityMatches(current.root, identity);
  const source = await qualifyHostedSource({ installation: current, identity, qualityApi, acceptedAt, now });
  const sourceState = assertSource(source, current, identity);
  const retained = parseJSON(await readRegularFile(join(resolve(rollbackDirectory), 'verified-release.private.json'), 1024 * 1024, true));
  check(retained.schema === 'shop.verified-workflow-release/v1' && /^[a-f0-9]{64}$/.test(retained.eventDigest), 'Retained immutable verified release locator required');
  const options = retained.options, originalAuthority = parseJSON(await readRegularFile(options.authority, 16 * 1024 * 1024, true));
  check(options.rootDigest === current.rootDigest && originalAuthority.payload.targetPlanDigest === current.contract.targetPlan.sha256 && originalAuthority.payload.writerFenceDigest === current.fenceDigest, 'Historical installation differs');
  const { contracts, dependencies, ...installedPolicy } = current.template;
  delete installedPolicy.schemaState;
  for (const [field, value] of Object.entries(installedPolicy)) if (field !== 'schema') check(same(originalAuthority.payload.policy[field], value), 'Historical policy is incompatible with current protected installation');
  check(same(originalAuthority.payload.secretInstallations, current.secretInstallations), 'Historical protected secret versions differ');
  const envelope = parseJSON(await readRegularFile(options.manifest, 16 * 1024 * 1024, true)), payload = envelope.payload;
  check(payload.components.every(component => same(component.contract, contracts[component.id])) && same(payload.dependencies, dependencies), 'Historical component contracts differ from current installation');
  check(digest(payload) === retained.compositionDigest && same(payload.repository, current.root.repository), 'Historical composition locator differs');
  // This original signed issuance time authenticates retained bytes only.
  // Current operation authority still requires the immutable remote verification.
  await admitPreviouslyVerifiedComposition({ bundle: options.bundle, manifest: options.manifest, trust: originalAuthority.payload.policy,
    domain: current.root.scope, originalAuthority, root: current.root,
    verification: { compositionDigest: digest(payload), verifiedAt: originalAuthority.payload.issuedAt } });
  let serving = { plan: current.plan, authorityFields: {} };
  if (current.providerPolicy.nativeServing) {
    const bytes = await readRegularFile(join(options.portable, 'portable-bundle.json'), 16 * 1024 * 1024, true);
    check(sha256(bytes) === originalAuthority.payload.portableManifests[0].manifestSha256, 'Historical portable manifest differs');
    const manifest = parseJSON(bytes);
    check(originalAuthority.payload.portableManifests.every(item => item.manifestSha256 === sha256(bytes) && item.lineageDigest === digest(manifest.lineage)),
      'Historical portable lineage differs');
    const historicalPortable = await verifyPortableBundle(options.portable, { manifestSha256: sha256(bytes),
      originSourceCommit: manifest.originSourceCommit, lineage: manifest.lineage, requireHostedLineage: true });
    serving = resolveServingPlan({ plan: current.plan, policy: current.providerPolicy, components: payload.components,
      portable: historicalPortable, nativeQualification: nativeQualificationContext(current, originalAuthority.payload.nativeQualifications ?? []) });
  }
  assertServingPlanAuthority(serving, originalAuthority.payload);
  await installedSigningKey(current, 'source'); await installedSigningKey(current, 'composition');
  const writer = await installedReader({ installation: current, payload, bundle: options.bundle, env, boundaries, now, evidenceDirectory,
    nativeQualificationReceipts: originalAuthority.payload.nativeQualifications ?? [], resolvedPlan: serving.plan,
    release: { head: identity.head, compositionDigest: digest(payload) } });
  const baseline = await writer.readHead(), verified = await writer.readVerification(retained.eventDigest);
  check(baseline?.state?.lastVerified && ['complete', 'reporting-pending', 'report-intent', 'report-reconcile'].includes(baseline.state.phase) &&
    (!baseline.state.operation || baseline.state.operation.kind === 'reports') && baseline.state.desired.rollbackCompositionDigest === digest(payload) &&
    baseline.state.history.some(item => same(item, payload)) && same(verified.lastVerified, payload) &&
    verified.verification?.compositionDigest === digest(payload), 'Historical rollback is not the authenticated compatible target');
  const historical = await admitPreviouslyVerifiedComposition({ bundle: options.bundle, manifest: options.manifest, trust: originalAuthority.payload.policy,
    domain: current.root.scope, originalAuthority, root: current.root, verification: verified.verification });
  check(same(historical.payload, payload) && same(await writer.readHead(), baseline), 'Historical rollback baseline changed');
  sourceState.verifyInvocation(await sourceState.read(sourceState.runPath));
  check((await sourceState.read(`${prefix}/git/ref/heads/main`)).object?.sha === identity.head, 'Canonical source changed before rollback authority');
  const issuedAt = now(), final = await refreshProtectedInstallation(current, issuedAt); assertSource(source, final, identity);
  const recovery = { kind: 'historical-rollback', compositionDigest: digest(payload), policyDigest: payload.policyDigest,
    verifiedEventDigest: retained.eventDigest, verifiedAt: verified.verification.verifiedAt,
    parentCompositionDigest: digest(baseline.state.lastVerified), originalAuthorityDigest: digest(originalAuthority) };
  const operationAuthorization = await installedOperationAuthorization(final, 'rollback', issuedAt);
  check(operationAuthorization.commands.includes('advance'), 'Historical rollback requires installed continuation authority');
  const authorityPayload = { ...clone(originalAuthority.payload), schema: 'shop.hosted-source-authority/v3', operationAuthorization, head: identity.head, base: source.base, tree: source.tree,
    workflowCommit: identity.workflowCommit, runId: identity.runId, attempt: identity.attempt, issuedAt, expiresAt: Math.min(issuedAt + final.root.maximumLifetimeMs, operationAuthorization.expiresAt),
    acceptedAt: source.acceptedAt, recovery, quality: { head: identity.head, runId: source.quality.qualityRunId, attempt: source.quality.qualityAttempt, releaseGuardDigest: digest(source.evidence) } };
  const key = await installedSigningKey(final, 'source');
  const authority = { payload: authorityPayload, signature: { algorithm: 'ECDSA_SHA_256', keyId: key.keyId, payloadDigest: digest(authorityPayload),
    signature: sign('sha256', Buffer.from(canonical(authorityPayload)), key.privateKey).toString('base64') } };
  verifyHostedAuthority(authority, { root: final.root, identity, now: issuedAt });
  const authorityPath = join(evidenceDirectory, `rollback-authority-${identity.runId}-${identity.attempt}.private.json`);
  await writeFile(authorityPath, canonical(authority), { flag: 'wx', mode: 0o600 });
  const sourceEvidence = join(evidenceDirectory, `rollback-source-${identity.runId}-${identity.attempt}.private.json`);
  await writeFile(sourceEvidence, canonical(source.evidence), { flag: 'wx', mode: 0o600 });
  return { options: { ...options, authority: authorityPath, originalAuthority: options.authority, trustRoot: current.rootPath, rootDigest: current.rootDigest, targetPlan: current.planPath, fence: current.fencePath, evidenceDirectory, sourceEvidence }, authority,
    evidence: { ...source.evidence, recovery }, readiness: { operationalApproval: true, productionDeliveryMeasured: false } };
}
