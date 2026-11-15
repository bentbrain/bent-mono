// Synthetic bytes for exercising the actual OCI producer and registration builders.
import { gzipSync } from 'node:zlib';
import { canonical, sha256 } from '../release-v2/data.mjs';
import { nativeV5Layer } from './native-v5-oci.mjs';

const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function createNativeOciFixture({ omitCa = false, badDiffId = false } = {}) {
  const baseFiles = ['bin/sh', 'usr/bin/dirname', ...(omitCa ? [] : ['etc/ssl/certs/ca-certificates.crt'])];
  const layer = Buffer.concat(baseFiles.map(path => {
    const record = nativeV5Layer([{ path: `opt/shop/${path}`, bytes: Buffer.from('synthetic base runtime'), mode: path.startsWith('etc/') ? 0o644 : 0o755 }]).subarray(-2048, -1024);
    record.fill(0, 0, 100); record.write(path); record.fill(0, 345, 500); record.fill(32, 148, 156);
    record.write(`${[...record.subarray(0, 512)].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148); return record;
  }).concat([Buffer.alloc(1024)]));
  const documents = new Map(), put = (mediaType, bytes) => { const hash = sha256(bytes); documents.set(`base/blobs/sha256/${hash}`, bytes); return { mediaType, digest: `sha256:${hash}`, size: bytes.length }; };
  const config = put('application/vnd.oci.image.config.v1+json', Buffer.from(canonical({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [`sha256:${badDiffId ? 'f'.repeat(64) : sha256(layer)}`] } })));
  const manifest = put('application/vnd.oci.image.manifest.v1+json', Buffer.from(canonical({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config,
    layers: [put('application/vnd.oci.image.layer.v1.tar+gzip', gzipSync(layer, { mtime: 0 }))] })));
  documents.set('base/index.json', Buffer.from(canonical({ schemaVersion: 2, manifests: [{ ...manifest, platform: { os: 'linux', architecture: 'amd64' } }] })));
  documents.set('base/oci-layout', Buffer.from(canonical({ imageLayoutVersion: '1.0.0' })));
  const base = { artifact: { component: 'native', format: 'oci-layout', root: 'base', entrypoint: 'base/index.json', files: [...documents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) },
    readFile: async ref => documents.get(ref.path), imageDigest: manifest.digest.slice(7), configDigest: config.digest.slice(7) };
  const paths = ['runtime/bin/node.real', 'runtime/bin/ffmpeg', 'runtime/bin/ffprobe', 'runtime/lib/ld-linux-x86-64.so.2',
    ...['native-v5-runtime.mjs', 'app-entry.mjs', 'failure-entry.mjs'].map(file => `runtime/products/shop/workers/video-renderer/aws-lambda/${file}`), 'native-image/product-image-v5-entry.mjs'];
  const files = paths.map(path => {
    let bytes = Buffer.from(`synthetic fixture ${path}`);
    if (path === 'runtime/bin/node.real' || path === 'runtime/lib/ld-linux-x86-64.so.2') { bytes = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(62, 18); }
    return { path, bytes, mode: path.includes('/bin/') || path.includes('/lib/') ? 0o755 : 0o644 };
  });
  const capsuleFiles = files.filter(file => file.path.startsWith('native-image/')).map(file => ({ path: file.path.slice(13), size: file.bytes.length, sha256: sha256(file.bytes) }));
  const capsuleBytes = json({ files: capsuleFiles, filesSha256: sha256(JSON.stringify(capsuleFiles)) });
  files.push({ path: 'native-image/capsule-manifest.json', bytes: capsuleBytes, mode: 0o644 });
  const runtimeFiles = files.filter(file => file.path.startsWith('runtime/')).map(file => ({ path: file.path.slice(8), bytes: file.bytes.length, sha256: sha256(file.bytes), executable: file.mode === 0o755 })).sort((a, b) => a.path < b.path ? -1 : 1);
  const sourceInventory = json({ files: [] }), identity = { schema: 'shop.native-v5-image-input/v1', sourceCommit: '1'.repeat(40), capsuleManifestSha256: sha256(capsuleBytes),
    runtimeFilesSha256: sha256(json(runtimeFiles)), sourceInventorySha256: sha256(sourceInventory) };
  const candidateReceipt = json({ sourceCommit: identity.sourceCommit, runtimeFiles, ...identity, awsImageQualified: false }); identity.candidateManifestSha256 = sha256(candidateReceipt);
  return { base, files, identity, candidateReceipt, sourceInventory };
}

