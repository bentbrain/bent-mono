import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, sha256 } from './data.mjs';
import { createNativeOciFixture } from '../testing/native-v5-oci-fixture.mjs';
import { createNativeV5Oci } from '../testing/native-v5-oci.mjs';
import { nativeV5Layer } from '../testing/native-v5-oci.mjs';
import { preflightImageRegistration, registerPreflightedImage } from './image-registration.mjs';
import { createHostedWriter } from './hosted-writer.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { hostedProtocolFixture } from './testing/hosted-protocol-service.mjs';

function imageFixture() {
  const documents = new Map(), root = 'native';
  const put = (path, bytes) => { documents.set(`${root}/${path}`, bytes); return bytes; };
  const descriptor = (mediaType, bytes) => { const hash = sha256(bytes); put(`blobs/sha256/${hash}`, bytes); return { mediaType, digest: `sha256:${hash}`, size: bytes.length }; };
  const layerBytes = [nativeV5Layer([{ path: 'opt/shop/a', bytes: Buffer.from('first'), mode: 0o644 }]), nativeV5Layer([{ path: 'opt/shop/b', bytes: Buffer.from('second'), mode: 0o755 }])];
  const layers = layerBytes.map(bytes => descriptor('application/vnd.oci.image.layer.v1.tar', bytes));
  const config = descriptor('application/vnd.oci.image.config.v1+json', Buffer.from(canonical({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: layers.map(item => item.digest) } })));
  const manifest = descriptor('application/vnd.oci.image.manifest.v1+json', Buffer.from(canonical({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config, layers })));
  put('index.json', Buffer.from(canonical({ schemaVersion: 2, manifests: [{ ...manifest, platform: { architecture: 'amd64', os: 'linux' } }] }))); put('oci-layout', Buffer.from(canonical({ imageLayoutVersion: '1.0.0' })));
  return { artifact: { component: 'native', format: 'oci-layout', root, entrypoint: 'native/index.json', files: [...documents].map(([path,bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) }, readFile: async ref => documents.get(ref.path), imageDigest: manifest.digest.slice(7) };
}

test('actual complete OCI bytes construct and register through custody and real ECR signing without runtime qualification', async () => {
  const { policy, functionName } = protocolFixture(), service = await hostedProtocolFixture({ policy, targets: [], realCredentials: true });
  try {
    const image = imageFixture(), graph = await preflightImageRegistration({ policy, resource: functionName, ...image });
    for (const operation of ['ecr.check-layers', 'ecr.initiate-layer', 'ecr.upload-part', 'ecr.complete-layer', 'ecr.put-image', 'ecr.get-image']) assert(graph.requests.some(item => item.request.operation === operation));
    assert.equal(graph.awsImageQualified, false); assert.equal(service.transcript.filter(item => item.method === 'POST').length, 0);
    const writer = createHostedWriter({ policy, broker: service.broker, fenceAdmission: service.fenceAdmission });
    const result = await writer.withWriter(async ({ commit }) => { await commit({ phase: 'image-registration-reconcile', operation: { id: 'register-image' } }); return registerPreflightedImage({ graph, writer, broker: service.broker, operationId: 'register-image' }); });
    assert.equal(result.registered, true); assert.equal(result.awsImageQualified, false); assert.equal(service.ecrBlobs.size, 3); assert.equal(service.ecrImages.size, 1);
    const before = service.transcript.filter(item => item.target?.endsWith('.PutImage')).length;
    await writer.withWriter(() => registerPreflightedImage({ graph, writer, broker: service.broker, operationId: 'register-image' }));
    assert.equal(service.transcript.filter(item => item.target?.endsWith('.PutImage')).length, before);
  } finally { await service.close(); }
});


test('default native producer output feeds exact ECR request construction while AWS qualification stays false', async () => {
  const produced = await createNativeV5Oci(createNativeOciFixture()), { policy, functionName } = protocolFixture();
  const graph = await preflightImageRegistration({ policy, resource: functionName, artifact: produced.artifact, readFile: async ref => produced.files.get(ref.path.slice('payload/native/'.length)) });
  assert.equal(graph.imageDigest, produced.graph.imageDigest); assert.equal(graph.awsImageQualified, false); assert.equal(produced.receipt.awsImageQualified, false);
  assert.equal(graph.requests.filter(item => item.request.operation === 'ecr.initiate-layer').length, produced.graph.layers + 1);
  assert(graph.requests.every(item => item.request.headers.host === 'api.ecr.ap-southeast-2.amazonaws.com'));
});
