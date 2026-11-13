import { check, parseJSON, same, sha256 } from './data.mjs';

const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const layers = new Set(['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd']);
const fields = (value, required, optional = []) => check(value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), 'Unsupported OCI document fields');
const annotations = value => { if (value !== undefined) check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 256 && typeof item === 'string' && item.length <= 4096), 'Invalid OCI annotations'); };

/** Verify the complete retained image graph. Runtime qualification is separate. */
export async function verifyOciLayout({ artifact, readFile }) {
  check(artifact.format === 'oci-layout' && artifact.component === 'native' && artifact.entrypoint === `${artifact.root}/index.json` && typeof readFile === 'function', 'Exact native OCI index entrypoint required');
  check(Array.isArray(artifact.files) && artifact.files.length >= 4 && artifact.files.length <= 4096 && new Set(artifact.files.map(file => file.path)).size === artifact.files.length, 'Complete unique OCI inventory required');
  const used = new Set();
  const read = async path => {
    const ref = artifact.files.find(file => file.path === `${artifact.root}/${path}`); check(ref, 'Referenced OCI object is missing');
    const bytes = await readFile(ref); check(Buffer.isBuffer(bytes) && bytes.length === ref.bytes && sha256(bytes) === ref.sha256, 'OCI retained object bytes differ');
    used.add(ref.path); return bytes;
  };
  const descriptor = async (value, types, platform = false) => {
    fields(value, ['mediaType', 'digest', 'size'], platform ? ['platform', 'annotations'] : ['annotations']); annotations(value.annotations);
    check(types.has(value.mediaType) && /^sha256:[a-f0-9]{64}$/.test(value.digest) && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 512 * 1024 * 1024, 'Invalid OCI descriptor');
    if (platform) { fields(value.platform, ['architecture', 'os']); check(['amd64', 'arm64'].includes(value.platform.architecture) && value.platform.os === 'linux', 'Supported single Linux OCI platform required'); }
    const bytes = await read(`blobs/sha256/${value.digest.slice(7)}`);
    check(bytes.length === value.size && sha256(bytes) === value.digest.slice(7), 'OCI descriptor content differs'); return bytes;
  };
  const layout = parseJSON(await read('oci-layout')); fields(layout, ['imageLayoutVersion']); check(layout.imageLayoutVersion === '1.0.0', 'Unsupported OCI layout version');
  const index = parseJSON(await read('index.json')); fields(index, ['schemaVersion', 'manifests'], ['mediaType', 'annotations']); annotations(index.annotations);
  check(index.schemaVersion === 2 && (index.mediaType === undefined || index.mediaType === 'application/vnd.oci.image.index.v1+json') && Array.isArray(index.manifests) && index.manifests.length === 1, 'Single complete OCI image required');
  const imageDescriptor = index.manifests[0], manifest = parseJSON(await descriptor(imageDescriptor, new Set([manifestType]), true));
  fields(manifest, ['schemaVersion', 'mediaType', 'config', 'layers'], ['annotations']); annotations(manifest.annotations);
  check(manifest.schemaVersion === 2 && manifest.mediaType === manifestType && Array.isArray(manifest.layers) && manifest.layers.length <= 1024, 'Unsupported OCI image manifest');
  const configuration = parseJSON(await descriptor(manifest.config, new Set([configType])), 16 * 1024 * 1024);
  check(configuration.os === 'linux' && configuration.architecture === imageDescriptor.platform.architecture && configuration.rootfs?.type === 'layers' && Array.isArray(configuration.rootfs.diff_ids) && configuration.rootfs.diff_ids.length === manifest.layers.length && configuration.rootfs.diff_ids.every(id => /^sha256:[a-f0-9]{64}$/.test(id)), 'OCI configuration platform or layer graph differs');
  check(configuration.history === undefined || Array.isArray(configuration.history) && configuration.history.length <= 4096, 'Invalid OCI history');
  for (const layer of manifest.layers) await descriptor(layer, layers);
  check(same([...used].sort(), artifact.files.map(file => file.path).sort()), 'OCI inventory contains unreferenced objects');
  return { imageDigest: imageDescriptor.digest.slice(7), architecture: configuration.architecture, layers: manifest.layers.length, runtimeQualified: false };
}
