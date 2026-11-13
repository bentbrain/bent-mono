import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical, check, digest, parseJSON, readRef, readRegularFile, same, sha256 } from './data.mjs';
import { advanceWithPorts } from './controller.mjs';
import { actionsIdentity, admitHostedComposition } from './hosted-admission.mjs';
import { exactFields, protocolPolicy } from './provider-protocol-builders.mjs';
import { verifyPortableBundle } from './portable-bundle.mjs';
import { admitCredentialFence, credentialBrokerBoundary, createHostedWriter } from './hosted-writer.mjs';
import { createHostedProvider, preflightHostedTargets, retainedCandidateLoader } from './hosted-provider.mjs';
import { createBrokerTransport, requestBrokerIdentity } from './broker-transport.mjs';
import { journey } from './journey.mjs';
import { hostedReporting } from './hosted-reporting.mjs';
import { saveHostedFailure } from './hosted-diagnostics.mjs';

const commands = new Set(['plan', 'advance', 'begin', 'rollback', 'recover-report']);

export async function admitHostedInvocation(options) {
  check(commands.has(options.command ?? 'plan'), 'Unknown hosted qualification operation');
  const identity = actionsIdentity(options.env ?? process.env);
  const admission = await admitHostedComposition({ ...options, identity });
  const authority = admission.hostedAuthority.payload;
  const bytes = await readRegularFile(options.targetPlan, 16 * 1024 * 1024, true); check(bytes.length <= 16 * 1024 * 1024 && sha256(bytes) === authority.targetPlanDigest, 'Signed target plan bytes differ');
  const plan = parseJSON(bytes, 16 * 1024 * 1024);
  exactFields(plan, ['schema', 'scope', 'providerPolicy', 'targets', 'deploymentId', 'journeyOrigin']);
  check(plan.schema === 'shop.hosted-target-plan/v1' && plan.scope === 'isolated-qualification', 'Isolated target plan required');
  const policy = protocolPolicy(plan.providerPolicy);
  check(digest(policy) === authority.providerPolicyDigest && policy.github.environment === admission.root.environment &&
    policy.github.repository === admission.root.repositoryName && policy.github.deploymentIds.includes(plan.deploymentId), 'Target policy or reporting installation differs');
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
  return { admission, authority, plan, policy, portable };
}

export async function hostedController(options, boundaries = {}) {
  if (options.command === 'recover-report') return hostedReporting(options, boundaries);
  const admitted = await admitHostedInvocation(options), { admission, authority, plan, policy } = admitted;
  const command = options.command ?? 'plan';
  if (command === 'plan') {
    return { schema: 'shop.hosted-plan/v1', scope: 'isolated-qualification', phase: 'plan-admitted',
      compositionDigest: admission.compositionDigest, authorityDigest: admission.hostedAuthority.authorityDigest,
      portableManifestDigest: admitted.portable.manifestSha256, providerWrites: 0, operationalApproval: false,
      readiness: { awsImageQualified: authority.portableManifests.every(item => item.component !== 'native' || item.awsImageQualified),
        credentialCustodyRequired: true, realProviderQualificationRequired: true } };
  }
  check(typeof options.fence === 'string' && typeof options.evidenceDirectory === 'string', 'Explicit installed custody receipt and private evidence destination required');
  const fenceBytes = await readRegularFile(options.fence, 65536, true);
  check(fenceBytes.length <= 65536 && sha256(fenceBytes) === authority.writerFenceDigest, 'Independently admitted credential custody receipt differs');
  const installedBroker = admission.root.credentialBroker;
  const fence = admitCredentialFence(parseJSON(fenceBytes, 65536), { keys: installedBroker.keys, policy,
    environmentId: installedBroker.environmentId, brokerId: installedBroker.id, implementationDigest: installedBroker.implementationDigest });
  const load = retainedCandidateLoader({ bundle: options.bundle, targets: plan.targets });
  await preflightHostedTargets({ policy, components: admission.payload.components, targets: plan.targets, load });
  const transport = boundaries.broker ?? createBrokerTransport({ root: admission.root,
    token: await requestBrokerIdentity({ root: admission.root, env: options.env ?? process.env }) });
  const broker = credentialBrokerBoundary({ fenceAdmission: fence, boundary: transport });
  const writer = createHostedWriter({ policy, broker, fenceAdmission: fence });
  const provider = createHostedProvider({ policy, writer, broker, components: admission.payload.components, targets: plan.targets,
    load, deploymentId: plan.deploymentId,
    workInventory: () => broker.workInventory() });
  return advanceWithPorts({ ...options, directory: options.evidenceDirectory, origin: plan.journeyOrigin, command }, {
    // Every transition authenticates the authority again. A new process cannot
    // replace the target, admitted input or protected journal with local state.
    admit: async () => (await admitHostedInvocation(options)).admission,
    withWriter: writer.withWriter, readHead: writer.readHead, provider,
    stageRequest: provider.stageRequest, verifyContent: provider.verifyContent, verificationRef: writer.verificationRef,
    journey: boundaries.journey ?? journey,
    context: { id: `protected-policy:${digest(policy)}`, scope: 'isolated-qualification', stateSchema: 'shop.hosted-release/v1',
      verificationSchema: 'shop.hosted-verification/v1', budgetScope: 'accepted-source-to-isolated-verification',
      startedAt: authority.acceptedAt, verificationEvent: true }
  });
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
