import { check, digest, same, sha256 } from './data.mjs';
import { assertPolicy, requestBuilders } from './provider-protocol-builders.mjs';
import { requestDigest } from './signing.mjs';
import { verifyOciLayout } from './oci-layout.mjs';
import { responseBytes } from './provider-protocol.mjs';

const prepared = new WeakMap(), partSize = 20971520;
export async function preflightImageRegistration({ policy, resource, artifact, readFile }) {
  assertPolicy(policy); check(policy.functions.some(item => item.name === resource) && typeof readFile === 'function', 'Exact retained image registration target required');
  const image = await verifyOciLayout({ artifact, readFile }), builders = requestBuilders(policy), requests = [], uuid = '00000000-0000-4000-8000-000000000000';
  const append = (request, deferred = [], source = null) => { const { bodyBase64, ...framing } = request; requests.push({ request: framing, requestDigest: requestDigest(request), bodyBytes: Buffer.from(bodyBase64, 'base64').length, deferred, source }); };
  const blobs = [{ descriptor: image.configDescriptor, ref: image.descriptorRefs.config }, ...image.layerDescriptors.map((descriptor,index) => ({ descriptor, ref: image.descriptorRefs.layers[index] }))];
  for (let at = 0; at < blobs.length; at += 100) append(builders.ecrCheckLayers(resource, blobs.slice(at, at + 100).map(item => item.descriptor.digest.slice(7))));
  for (const blob of blobs) {
    const bytes = await readFile(blob.ref); check(Buffer.isBuffer(bytes) && bytes.length === blob.descriptor.size && `sha256:${sha256(bytes)}` === blob.descriptor.digest, 'Exact image registration blob bytes differ');
    append(builders.ecrInitiateLayer(resource, blob.descriptor.digest.slice(7)), [], blob.ref);
    for (let offset = 0; offset < bytes.length; offset += partSize) append(builders.ecrUploadPart(resource, uuid, bytes.subarray(offset, offset + partSize), offset), ['providerUploadId'], { ref: blob.ref, offset, bytes: Math.min(partSize, bytes.length - offset) });
    append(builders.ecrCompleteLayer(resource, uuid, blob.descriptor.digest.slice(7)), ['providerUploadId'], blob.ref);
  }
  const manifest = await readFile(image.descriptorRefs.manifest); append(builders.ecrPutImage(resource, manifest, image.imageDigest)); append(builders.ecrGetImage(resource, image.imageDigest));
  const graph = Object.freeze({ schema: 'shop.image-registration-graph/v1', policyDigest: digest(policy), resource, imageDigest: image.imageDigest, requests, digest: digest(requests), providerWrites: 0, awsImageQualified: false });
  prepared.set(graph, { policy, resource, image, blobs, readFile, manifest }); return graph;
}

// Caller owns admitted source/bootstrap scope and the already committed exact
// operation. Registration does not produce Lambda runtime qualification.
export async function registerPreflightedImage({ graph, writer, broker, operationId }) {
  const value = prepared.get(graph); check(value && typeof operationId === 'string', 'Branded complete image registration graph required');
  const { policy, resource, image, blobs, readFile, manifest } = value, builders = requestBuilders(policy);
  const head = await writer.readHead(); check(head?.state.phase === 'image-registration-reconcile' && head.state.operation?.id === operationId, 'Admitted durable image registration operation required');
  const read = async request => { const response = await broker.read(request); check(response.status === 200, 'Image registration readback failed'); return JSON.parse(responseBytes(response)); };
  const existing = await read(builders.ecrGetImage(resource, image.imageDigest));
  const matching = existing.images?.filter(item => item.imageId?.imageDigest === `sha256:${image.imageDigest}` && item.imageManifest === manifest.toString('utf8')) ?? [];
  check(matching.length <= 1 && Array.isArray(existing.failures), 'Complete exact ECR image inventory required');
  if (matching.length) return { imageDigest: image.imageDigest, registered: true, awsImageQualified: false };
  const send = async (step, request, precondition) => {
    const state = await writer.readProviderState(), prior = state.requests.find(item => item.operationId === operationId && item.step === step);
    check(!prior, 'Unknown image registration acknowledgement; observation only, no write replay');
    const event = await writer.recordProvider(provider => provider.requests.push({ operationId, step, requestDigest: requestDigest(request), method: request.method, url: request.url, bodySha256: request.bodySha256, bytes: Buffer.from(request.bodyBase64, 'base64').length, headers: request.headers, target: { kind: 'ecr', resource, imageDigest: image.imageDigest }, precondition, status: 'intent' }));
    const response = await writer.dispatch(request, event); check(response.status === 200, 'Image registration acknowledgement failed'); const result = JSON.parse(responseBytes(response));
    await writer.recordProvider(provider => { const saved = provider.requests.find(item => item.operationId === operationId && item.step === step); saved.status = 'acknowledged'; saved.responseDigest = digest(response); }); return result;
  };
  for (const blob of blobs) {
    const hex = blob.descriptor.digest.slice(7), checked = await read(builders.ecrCheckLayers(resource, [hex])); check(Array.isArray(checked.layers) && Array.isArray(checked.failures) && checked.failures.length === 0, 'Complete ECR blob availability required');
    if (checked.layers.some(item => item.layerDigest === blob.descriptor.digest && item.layerAvailability === 'AVAILABLE' && item.layerSize === blob.descriptor.size)) continue;
    const initialized = await send(`init-${hex}`, builders.ecrInitiateLayer(resource, hex), { blobDigest: blob.descriptor.digest });
    check(initialized.registryId === policy.awsAccountId && initialized.repositoryName === policy.functions.find(item => item.name === resource).imageRepository.split('.amazonaws.com/')[1], 'ECR initiation target differs');
    const bytes = await readFile(blob.ref); check(sha256(bytes) === hex && bytes.length === blob.descriptor.size, 'Image blob changed after preflight');
    for (let offset = 0; offset < bytes.length; offset += partSize) { const part = bytes.subarray(offset, offset + partSize), uploaded = await send(`part-${hex}-${offset}`, builders.ecrUploadPart(resource, initialized.uploadId, part, offset), { blobDigest: blob.descriptor.digest, offset }); check(uploaded.uploadId === initialized.uploadId && uploaded.lastByteReceived === offset + part.length - 1, 'ECR part acknowledgement differs'); }
    const completed = await send(`complete-${hex}`, builders.ecrCompleteLayer(resource, initialized.uploadId, hex), { blobDigest: blob.descriptor.digest }); check(completed.layerDigest === blob.descriptor.digest, 'ECR completed blob digest differs');
  }
  const uploaded = await send('put-image', builders.ecrPutImage(resource, manifest, image.imageDigest), { imageDigest: image.imageDigest });
  check(uploaded.image?.imageId?.imageDigest === `sha256:${image.imageDigest}` && uploaded.image.imageManifest === manifest.toString('utf8'), 'ECR image acknowledgement differs');
  const observed = await read(builders.ecrGetImage(resource, image.imageDigest)); check(observed.images?.length === 1 && observed.failures?.length === 0 && observed.images[0].imageManifest === manifest.toString('utf8') && observed.images[0].imageId.imageDigest === `sha256:${image.imageDigest}`, 'ECR immutable image readback differs');
  return { imageDigest: image.imageDigest, registered: true, awsImageQualified: false };
}
