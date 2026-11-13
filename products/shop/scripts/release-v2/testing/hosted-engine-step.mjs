import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, check, digest, parseJSON, readRef } from '../data.mjs';
import { fixtureEnvironment, loopbackOrigin } from '../provider.mjs';
import { protocolPolicy } from '../provider-protocol-builders.mjs';
import { admitCredentialFence, credentialBrokerBoundary, createHostedWriter } from '../hosted-writer.mjs';
import { createHostedProvider, retainedCandidateLoader } from '../hosted-provider.mjs';
import { advanceWithPorts } from '../controller.mjs';
import { literalJSON } from './hosted-protocol-service.mjs';

// This executable verifies the engine/provider/storage path. Protected source
// authority cryptography is exercised by the guarded hosted-entrypoint tests.
export async function hostedEngineStep(config) {
  const policy = protocolPolicy(config.policy); loopbackOrigin(config.custodyOrigin);
  const fenceAdmission = admitCredentialFence(config.fenceReceipt, { keys: config.fenceKeys, policy, environmentId: 'synthetic-qualification', brokerId: 'synthetic-custody', implementationDigest: config.fenceReceipt.payload.implementationDigest });
  const broker = credentialBrokerBoundary({ fenceAdmission, boundary: input => literalJSON(config.custodyOrigin, input) }), writer = createHostedWriter({ policy, broker, fenceAdmission });
  const load = retainedCandidateLoader({ bundle: config.bundle, targets: config.targets });
  const provider = createHostedProvider({ policy, writer, broker, components: config.payload.components, targets: config.targets, load, deploymentId: '123' });
  const compositionDigest = digest(config.payload), admission = { payload: config.payload, compositionDigest, trust: { scope: 'isolated-qualification', budgetMs: 600000 } };
  const journey = async ({ phase }) => {
    const observed = [];
    for (const component of config.payload.components) {
      const candidate = await load(component), code = await readRef(config.bundle, candidate.artifact.files.find(file => file.path === candidate.artifact.entrypoint));
      const module = await import(`data:text/javascript;base64,${code.toString('base64')}`); check(module.component === component.id, 'Retained synthetic module execution differs'); observed.push({ component: component.id, codeDigest: component.codeDigest ?? component.artifact.sha256 });
    }
    return { schema: 'shop.synthetic-artifact-execution/v1', scope: 'loopback-engine-test', compositionDigest, phase, exitCode: 0, observed };
  };
  const ports = { admit: async () => admission, withWriter: writer.withWriter, readHead: writer.readHead, provider, journey, stageRequest: provider.stageRequest, verifyContent: provider.verifyContent, verificationRef: writer.verificationRef,
    context: { id: 'synthetic-protected-environment', scope: 'isolated-qualification', stateSchema: 'shop.hosted-release/v1', verificationSchema: 'shop.hosted-verification/v1', budgetScope: 'synthetic-hosted-engine', startedAt: config.startedAt, verificationEvent: true } };
  return advanceWithPorts({ bundle: config.bundle, command: config.command ?? 'advance' }, ports);
}
async function main() {
  fixtureEnvironment(process.env); check(process.argv.length === 3, 'One private test configuration required');
  const config = parseJSON(await readFile(resolve(process.argv[2]))), state = await hostedEngineStep(config);
  process.stdout.write(`${canonical({ phase: state.phase, generation: state.generation, waiting: state.waiting ?? null })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
