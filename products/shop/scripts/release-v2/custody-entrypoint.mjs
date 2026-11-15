import { createPrivateKey, createPublicKey, sign, X509Certificate } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import { parseArgs } from 'node:util';
import { canonical, check, digest, parseJSON, readRegularFile, sha256 } from './data.mjs';
import { exactFields, protocolPolicy } from './provider-protocol-builders.mjs';
import { readInstalledRoot } from './hosted-admission.mjs';
import { admitCredentialFence } from './hosted-writer.mjs';
import { createProviderSigner } from './provider-credentials.mjs';
import { signingTrust } from './signing.mjs';
import { protocolClient } from './provider-protocol.mjs';
import { protectedStore } from './protected-store.mjs';
import { createHttpsTransport } from './https-transport.mjs';
import { createActionsAuthenticator } from './actions-authentication.mjs';
import { createCredentialCustody, preflightCustodyRequests } from './custody-service.mjs';
import { createRetainedAssetResolver } from './custody-observations.mjs';

const checkout = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const maximumBody = 256 * 1024 * 1024;
async function privateBytes(path, maximum = 65536) {
  check(typeof path === 'string' && path === resolve(path) && path !== checkout && !path.startsWith(`${checkout}${sep}`),
    'Credential service files must be independently installed outside source');
  const before = await lstat(path), parent = await lstat(dirname(path));
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && (before.mode & 0o777) === 0o600 &&
    parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o777) === 0o700 && await realpath(path) === path &&
    (typeof process.getuid !== 'function' || before.uid === process.getuid() && parent.uid === process.getuid()),
  'Private owned credential service installation required');
  const bytes = await readRegularFile(path, maximum, true), after = await lstat(path);
  check(['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => before[key] === after[key]),
    'Credential service file changed during inspection');
  return bytes;
}
async function pinnedBytes(reference, maximum) {
  exactFields(reference, ['path', 'sha256']);
  check(/^[a-f0-9]{64}$/.test(reference.sha256), 'Independent credential service digest required');
  const bytes = await privateBytes(reference.path, maximum);
  check(sha256(bytes) === reference.sha256, 'Credential service installed bytes differ');
  return bytes;
}

/** The controller supplies signed calls, never credentials or adapter functions. */
export function custodyInvocationHandler(service) {
  check(service && typeof service.handle === 'function', 'Installed credential custody required');
  return async (request, response) => {
    const answer = (status, value) => {
      if (response.destroyed || response.headersSent) return;
      const body = Buffer.from(canonical(value));
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length), 'cache-control': 'no-store' });
      response.end(body);
    };
    try {
      check(request.method === 'POST' && request.url === '/v1/invocations', 'Exact custody invocation route required');
      check(request.headers['content-type'] === 'application/json' && typeof request.headers.authorization === 'string' &&
        /^Bearer [A-Za-z0-9_.-]{1,32768}$/.test(request.headers.authorization), 'Bounded signed workflow identity required');
      const lengths = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'content-length');
      check(lengths.length === 1 && request.headers['transfer-encoding'] === undefined &&
        /^(0|[1-9][0-9]*)$/.test(request.headers['content-length'] ?? ''), 'Exact custody request framing required');
      const declared = Number(request.headers['content-length']);
      check(Number.isSafeInteger(declared) && declared > 0 && declared <= maximumBody, 'Custody request exceeds bound');
      const parts = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; check(size <= declared, 'Custody request length differs'); parts.push(chunk); }
      check(request.complete && size === declared, 'Complete custody request required');
      const result = await service.handle(parseJSON(Buffer.concat(parts), maximumBody), { authorization: request.headers.authorization });
      const body = Buffer.from(canonical(result)); check(body.length <= maximumBody, 'Custody response exceeds bound');
      answer(200, result);
    } catch {
      // A provider write may already have happened. The caller must reconcile;
      // it cannot infer absence or retry from this deliberately fixed response.
      answer(503, { error: 'Custody invocation stopped. Reconcile retained state before another write.' });
    }
  };
}

/** Load the protected service installation. Test boundaries replace transport and public JWKS data only. */
async function prepareCustody({ path, digest: expectedDigest }, boundaries = {}) {
  check(Object.keys(boundaries).every(key => ['transport', 'readGithubKeys'].includes(key)), 'Unsupported credential service boundary');
  const bytes = await pinnedBytes({ path, sha256: expectedDigest }), config = parseJSON(bytes);
  exactFields(config, ['schema', 'root', 'providerPolicy', 'custodyPolicy', 'fence', 'installation', 'replacement',
    'providerSigner', 'custodySigner', 'attestation', 'assetCatalog', 'tls',...(Object.hasOwn(config,'nativeFixtureGrantKey')?['nativeFixtureGrantKey']:[])]);
  check(config.schema === 'shop.credential-service-installation/v1', 'Credential service installation required');
  const root = await readInstalledRoot(config.root.path, config.root.sha256);
  await pinnedBytes(config.root);
  const document = async (ref,finiteFractions=false) => parseJSON(await pinnedBytes(ref),65536,{finiteFractions});
  const policy = protocolPolicy(await document(config.providerPolicy,true)), custodyPolicy = protocolPolicy(await document(config.custodyPolicy,true));
  check(root.providerPolicyDigest === digest(policy), 'Credential service policy differs from independent root');
  const fenceAdmission = admitCredentialFence(await document(config.fence), { keys: root.credentialBroker.keys, policy,
    environmentId: root.credentialBroker.environmentId, brokerId: root.credentialBroker.id,
    implementationDigest: root.credentialBroker.implementationDigest });
  const installation = await document(config.installation), replacement = config.replacement === null ? null : await document(config.replacement);
  const nativeFixtureGrantKey=config.nativeFixtureGrantKey?await document(config.nativeFixtureGrantKey):null;
  if(policy.nativeQualification?.fixtureLifecycle)check(nativeFixtureGrantKey,'Independently installed native fixture grant key required');
  async function signerFor(entry, targetPolicy) {
    exactFields(entry, ['keyId', 'key', 'credentialEpoch', 'credentialsPath']);
    check(entry.credentialEpoch === installation.payload.credentialEpoch, 'Credential service epoch differs');
    const privateKeyPem = (await pinnedBytes(entry.key, 8192)).toString('utf8');
    const publicKey = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });
    const getCredentials = async ({ credentialEpoch }) => {
      const current = parseJSON(await privateBytes(entry.credentialsPath));
      exactFields(current, ['credentialEpoch', 'session', 'bearerTokens']);
      check(current.credentialEpoch === credentialEpoch, 'Renewable credentials moved to another epoch'); return current;
    };
    return { signer: createProviderSigner({ policy: targetPolicy, getCredentials, credentialEpoch: entry.credentialEpoch, keyId: entry.keyId, privateKeyPem }),
      trust: signingTrust({ policy: targetPolicy, keys: [{ id: entry.keyId, publicKey }] }) };
  }
  const provider = await signerFor(config.providerSigner, policy), custody = await signerFor(config.custodySigner, custodyPolicy);
  exactFields(config.attestation, ['keyId', 'key']);
  const attestationKey = createPrivateKey(await pinnedBytes(config.attestation.key, 8192));
  const admittedKey = root.credentialBroker.keys.find(key => key.id === config.attestation.keyId);
  check(attestationKey.asymmetricKeyType === 'ed25519' && admittedKey &&
    createPublicKey(attestationKey).export({ type: 'spki', format: 'pem' }) === admittedKey.publicKeyPem,
  'Custody attestation key differs from independent root');
  exactFields(config.tls, ['host', 'port', 'key', 'certificate']);
  check(['127.0.0.1', '0.0.0.0', '::1', '::'].includes(config.tls.host) && Number.isSafeInteger(config.tls.port) &&
    config.tls.port > 0 && config.tls.port <= 65535, 'Explicit custody listener required');
  const tls = { host: config.tls.host, port: config.tls.port, key: await pinnedBytes(config.tls.key, 16384),
    cert: await pinnedBytes(config.tls.certificate, 65536), minVersion: 'TLSv1.2' };
  createSecureContext(tls);
  check(new X509Certificate(tls.cert).checkHost(new URL(root.credentialBroker.origin).hostname),
    'Credential service certificate differs from installed broker origin');
  const assetCatalog = config.assetCatalog === null ? undefined : parseJSON(await pinnedBytes(config.assetCatalog, 16 * 1024 * 1024), 16 * 1024 * 1024);
  check(policy.workInventory && assetCatalog, 'Installed durable work inventory and retained asset catalog required');
  const assetRoot = await realpath(assetCatalog.bundle), privatePaths = [path, config.root.path, config.providerPolicy.path,
    config.custodyPolicy.path, config.fence.path, config.installation.path, config.providerSigner.key.path,
    config.providerSigner.credentialsPath, config.custodySigner.key.path, config.custodySigner.credentialsPath,
    config.attestation.key.path, config.tls.key.path,...(config.nativeFixtureGrantKey?[config.nativeFixtureGrantKey.path]:[])];
  check(privatePaths.every(file => file !== assetRoot && !file.startsWith(`${assetRoot}${sep}`)),
    'Credential service authority must remain outside retained artifacts');
  const resolveAssets = createRetainedAssetResolver(assetCatalog);
  for (const entry of assetCatalog.entries) await resolveAssets({ resource: entry.resource, manifestDigest: entry.manifestDigest });
  // Validate every local installation input before even the first custody-store read.
  check(sha256(await privateBytes(path)) === expectedDigest, 'Credential service installation changed');
  const transport = boundaries.transport ?? createHttpsTransport({ policy });
  const custodyTransport = boundaries.transport ?? createHttpsTransport({ policy: custodyPolicy });
  const custodyStore = protectedStore(protocolClient({ policy: custodyPolicy, ...custody, transport: custodyTransport }), custodyPolicy);
  const { digest: custodyGraphDigest, ...custodyGraph } = await preflightCustodyRequests({ policy, custodyPolicy, fenceAdmission, installation, assetCatalog });
  const graph = { ...custodyGraph, custodyGraphDigest, configurationDigest: expectedDigest, rootDigest: config.root.sha256,
    publicIdentityRequest: { method: 'GET', url: 'https://token.actions.githubusercontent.com/.well-known/jwks' } };
  const requestGraph = { ...graph, digest: digest(graph) };
  const serviceOptions = { policy, custodyPolicy, custodyStore, fenceAdmission, installation, replacement,
    ...provider, transport, assetCatalog, resolveAssets, nativeBootstrapRoot:root,nativeFixtureGrantKey,
    authenticate: createActionsAuthenticator({ root, policy, fenceAdmission, ...(boundaries.readGithubKeys ? { readKeys: boundaries.readGithubKeys } : {}) }),
    attest: async payload => ({ keyId: config.attestation.keyId, payload, signature: sign(null, Buffer.from(canonical(payload)), attestationKey).toString('base64') }) };
  return { requestGraph, start: async () => {
    const service = await createCredentialCustody(serviceOptions);
    return { service, handler: custodyInvocationHandler(service), tls, requestGraph };
  } };
}

/** Construct the independent custody namespace requests without opening a listener or reading the provider. */
export async function planConfiguredCustody(options) { return (await prepareCustody(options)).requestGraph; }
export async function configuredCustody(options, boundaries) { return (await prepareCustody(options, boundaries)).start(); }

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, options: { configuration: { type: 'string' }, digest: { type: 'string' }, operation: { type: 'string', default: 'plan' } } });
  check(values.configuration && values.digest, 'Provide the independently pinned credential service configuration');
  check(['plan', 'serve'].includes(values.operation), 'Choose plan or serve for the credential service');
  if (values.operation === 'plan') {
    const graph = await planConfiguredCustody({ path: values.configuration, digest: values.digest });
    return { schema: graph.schema, requestGraphDigest: digest(graph), requestCount: graph.requests.length, providerWrites: 0 };
  }
  const installed = await configuredCustody({ path: values.configuration, digest: values.digest });
  const server = createServer(installed.tls, installed.handler);
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxRequestsPerSocket = 256;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(installed.tls.port, installed.tls.host, accept); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().then(result => { if (!result.listen) process.stdout.write(`${canonical(result)}\n`); })
    .catch(() => { process.stderr.write('Credential service startup stopped. Preserve private installation evidence.\n'); process.exitCode = 1; });
