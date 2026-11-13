import { check, parseJSON, readRef, sha256, same } from './data.mjs';
import { conforms } from './composition.mjs';
import { codeIdentity } from './component-identity.mjs';

export const fixtureTransportByteLimit = 256 * 1024 * 1024;
export async function stageRequest(bundle, intent) {
  const artifact = await readRef(bundle, intent.artifact), config = await readRef(bundle, intent.config), provenance = await readRef(bundle, intent.provenance);
  const manifest = parseJSON(artifact); conforms(manifest, 'artifact');
  const files = [];
  let bytes = artifact.length + config.length + provenance.length;
  for (const file of manifest.files) {
    bytes += file.bytes;
    check(bytes * 2 < fixtureTransportByteLimit, 'Artifact exceeds local transport proof bound; retain all files and qualify its storage adapter');
    files.push({ path: file.path, data: (await readRef(bundle, file)).toString('base64') });
  }
  return { ...intent, upload: { artifact: artifact.toString('base64'), config: config.toString('base64'), provenance: provenance.toString('base64'), files } };
}
const exactKeys = (value, names) => check(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...names].sort()), 'Unexpected artifact transport fields');
const decode = data => {
  check(typeof data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(data), 'Malformed base64 content');
  const bytes = Buffer.from(data, 'base64');
  check(bytes.toString('base64') === data, 'Ambiguous base64 content');
  return bytes;
};
export function verifyContent(upload, component, domain = 'inactive-loopback') {
  check(['inactive-loopback', 'isolated-qualification'].includes(domain), 'Artifact content trust domain differs');
  exactKeys(upload, ['artifact', 'config', 'provenance', 'files']);
  const documents = {};
  for (const kind of ['artifact', 'config', 'provenance']) {
    const bytes = decode(upload[kind]), expected = component[kind];
    check(bytes.length === expected.bytes && sha256(bytes) === expected.sha256, 'Provider artifact/config/provenance bytes differ');
    documents[kind] = parseJSON(bytes); conforms(documents[kind], kind === 'config' && domain === 'isolated-qualification' ? 'hostedConfig' : kind === 'provenance' && domain === 'isolated-qualification' ? 'hostedProvenance' : kind);
  }
  const manifest = documents.artifact;
  if (manifest.schema === 'shop.artifact/v2') check(manifest.codeDigest === codeIdentity(manifest), 'Provider code identity differs');
  check(Array.isArray(upload.files) && upload.files.length === manifest.files.length, 'Provider file inventory is incomplete');
  const found = new Set();
  for (const file of upload.files) {
    exactKeys(file, ['path', 'data']);
    check(!found.has(file.path), 'Provider duplicate artifact path'); found.add(file.path);
    const expected = manifest.files.find(item => item.path === file.path), bytes = decode(file.data);
    check(expected && expected.bytes === bytes.length && expected.sha256 === sha256(bytes), 'Provider executable/asset bytes differ');
  }
  return manifest;
}
