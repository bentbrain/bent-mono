import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeOciFixture as fixture } from './native-v5-oci-fixture.mjs';
import { createNativeV5Oci, inspectBaseLayer, nativeV5Layer, verifyNativeV5OciReceipt } from './native-v5-oci.mjs';
import { createNativeV5Handler, runNativeV5Runtime } from '../../workers/video-renderer/aws-lambda/native-v5-runtime.mjs';


test('deterministic native OCI graph retains pinned base and full payload without runtime qualification', async () => {
  const input = fixture(), first = await createNativeV5Oci(input), second = await createNativeV5Oci({ ...input, files: [...input.files].reverse() });
  assert.equal(first.graph.imageDigest, second.graph.imageDigest); assert.deepEqual(first.files, second.files);
  assert.equal(first.receipt.awsImageQualified, false); assert.equal(first.receipt.runtimeQualified, false);
  assert.equal(first.graph.layers, 2); assert.equal(first.graph.descriptorRefs.layers.length, 2);
  assert.equal(first.graph.configDescriptor.digest.slice(7), first.receipt.configDigest);
  assert.equal(first.receipt.inventory.length, input.files.length);
  const readFile = async ref => first.files.get(ref.path.slice('payload/native/'.length));
  const verified = await verifyNativeV5OciReceipt({ graph: first.graph, receipt: first.receipt, readFile });
  assert.equal(verified.inventorySha256, first.receipt.inventorySha256);
  await assert.rejects(verifyNativeV5OciReceipt({ graph: first.graph, receipt: { ...first.receipt, inventory: first.receipt.inventory.slice(1) }, readFile }), /inventory differs/);
  await assert.rejects(verifyNativeV5OciReceipt({ graph: first.graph, receipt: { ...first.receipt, baseImageDigest: 'f'.repeat(64) }, readFile }), /base receipt differs/);
});
for (const [name, change] of [
  ['missing complete base', input => { delete input.base; }],
  ['base pin mismatch', input => { input.base.imageDigest = 'a'.repeat(64); }],
  ['runtime byte substitution', input => { input.files[0].bytes = Buffer.from('changed'); }],
  ['missing compatibility handler', input => { input.files = input.files.filter(file => !file.path.endsWith('failure-entry.mjs')); }],
  ['changed source receipt', input => { input.sourceInventory = Buffer.from('{}'); }],
  ['symlink-like mode', input => { input.files[0].mode = 0o777; }],
  ['traversal', input => { input.files.push({ path: 'runtime/../../escape', bytes: Buffer.from('bad'), mode: 0o644 }); }],
]) test(`native OCI producer rejects ${name}`, async () => { const input = fixture(); change(input); await assert.rejects(createNativeV5Oci(input)); });
test('native OCI producer rejects absent CA closure and changed uncompressed layer identity', async () => {
  await assert.rejects(createNativeV5Oci(fixture({ omitCa: true })), /CA runtime closure/);
  await assert.rejects(createNativeV5Oci(fixture({ badDiffId: true })), /uncompressed layer digest/);
});
test('base tar inspector rejects truncation, bad checksums and unsafe member paths', () => {
  const layer = nativeV5Layer([{ path: 'opt/shop/a', bytes: Buffer.from('a'), mode: 0o644 }]);
  assert.throws(() => inspectBaseLayer(layer.subarray(0, layer.length - 1025)), /Truncated/);
  const changed = Buffer.from(layer); changed[0] ^= 1; assert.throws(() => inspectBaseLayer(changed), /checksum/);
  assert.throws(() => nativeV5Layer([{ path: 'opt/shop/../a', bytes: Buffer.from('a'), mode: 0o644 }]), /relative path/);
});
test('native runtime retains v5, v4/video and failure handler dispatch', async () => {
  const calls = [], route = createNativeV5Handler(Object.fromEntries(['v5', 'app', 'failure'].map(kind => [kind, async event => { calls.push(kind); return event; }])));
  for (const event of [{ kind: 'product-image-v5' }, { kind: 'product-image' }, { kind: 'story-video' }, { Records: [] }]) assert.deepEqual(await route(event, {}), event);
  assert.deepEqual(calls, ['v5', 'app', 'app', 'failure']);
});
for (const failed of [false, true]) test(`Runtime API posts exact ${failed ? 'sanitized error' : 'response'} and invocation identity`, async () => {
  const controller = new AbortController(), requests = [];
  await runNativeV5Runtime({ endpoint: '127.0.0.1:9001', signal: controller.signal, now: () => 1000,
    invoke: async (_event, context) => { assert.equal(context.getRemainingTimeInMillis(), 59000); if (failed) throw Error('private-grant'); return { ok: true }; },
    send: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) return new Response('{"kind":"product-image-v5"}', { status: 200, headers: {
        'lambda-runtime-aws-request-id': 'request-1', 'lambda-runtime-invocation-id': 'attempt-1', 'lambda-runtime-deadline-ms': '60000',
        'lambda-runtime-invoked-function-arn': 'arn:aws:lambda:ap-southeast-2:123456789012:function:synthetic:7' } });
      controller.abort(); return new Response(null, { status: 202 });
    } });
  assert.equal(requests.length, 2); assert.match(requests[1].url, new RegExp(`/request-1/${failed ? 'error' : 'response'}$`));
  assert.equal(requests[1].init.headers['lambda-runtime-invocation-id'], 'attempt-1'); assert.doesNotMatch(requests[1].init.body, /private-grant/);
});
