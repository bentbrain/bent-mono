import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, sha256 } from './data.mjs';
import { verifyOciLayout } from './oci-layout.mjs';

function fixture(change = () => {}) {
  const documents = new Map(), root = 'payload/native';
  const put = (path, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value)); documents.set(`${root}/${path}`, bytes); return bytes; };
  const descriptor = (mediaType, value) => { const bytes = Buffer.from(canonical(value)), hash = sha256(bytes); put(`blobs/sha256/${hash}`, bytes); return { mediaType, digest: `sha256:${hash}`, size: bytes.length }; };
  const config = { architecture: 'amd64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [] }, history: [] };
  const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: descriptor('application/vnd.oci.image.config.v1+json', config), layers: [] };
  const image = descriptor(manifest.mediaType, manifest);
  const index = { schemaVersion: 2, manifests: [{ ...image, platform: { architecture: 'amd64', os: 'linux' } }] };
  put('index.json', index); put('oci-layout', { imageLayoutVersion: '1.0.0' });
  change({ documents, put, descriptor, index, manifest, config });
  const artifact = { format: 'oci-layout', component: 'native', root, entrypoint: `${root}/index.json`, files: [...documents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) };
  return { artifact, readFile: async ref => documents.get(ref.path), imageDigest: image.digest.slice(7) };
}

test('retained single-platform OCI graph binds every byte without asserting runtime qualification', async () => {
  const f = fixture(), result = await verifyOciLayout(f);
  assert.equal(result.imageDigest, f.imageDigest); assert.equal(result.runtimeQualified, false); assert.equal(result.layers, 0);
});

for (const [name, change] of [
  ['missing configuration', ({ documents, manifest }) => documents.delete(`payload/native/blobs/sha256/${manifest.config.digest.slice(7)}`)],
  ['unreferenced payload', ({ put }) => put('unused.js', Buffer.from('unexpected'))],
  ['external blob URL', ({ put, index }) => { index.manifests[0].urls = ['https://example.com/image']; put('index.json', index); }],
  ['multiple manifests', ({ put, index }) => { index.manifests.push(index.manifests[0]); put('index.json', index); }],
  ['unsupported platform', ({ put, index }) => { index.manifests[0].platform.os = 'windows'; put('index.json', index); }],
  ['descriptor size mismatch', ({ put, index }) => { index.manifests[0].size++; put('index.json', index); }],
  ['missing layer', ({ put, descriptor, index, manifest }) => { manifest.layers.push({ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: `sha256:${'a'.repeat(64)}`, size: 1024 }); index.manifests[0] = { ...descriptor(manifest.mediaType, manifest), platform: { architecture: 'amd64', os: 'linux' } }; put('index.json', index); }],
]) test(`OCI admission rejects ${name}`, async () => { await assert.rejects(verifyOciLayout(fixture(change))); });

test('OCI admission rejects changed retained bytes and a non-index entrypoint', async () => {
  const f = fixture(); await assert.rejects(verifyOciLayout({ ...f, readFile: async () => Buffer.from('{}') }), /bytes differ/);
  f.artifact.entrypoint = 'payload/native/oci-layout'; await assert.rejects(verifyOciLayout(f), /index entrypoint/);
});
