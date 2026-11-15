import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, pathName, sha256 } from '../release-v2/data.mjs';
import { createNativeOciFixture as fixture } from './native-v5-oci-fixture.mjs';
import { createNativeV5Oci, inspectBaseLayer, nativeV5Layer, verifyNativeV5BaseClosure, verifyNativeV5OciReceipt } from './native-v5-oci.mjs';
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
// Model base records independently from the stricter application/locator names.
function baseLayer(records) {
  return Buffer.concat([...records.map(({ path, bytes = Buffer.alloc(0), kind = '0', link = '', mode = 0o644 }) => {
    const encoded = nativeV5Layer([{ path: 'opt/shop/member', bytes, mode }]);
    const record = Buffer.from(encoded.subarray(-1024 - 512 - Math.ceil(bytes.length / 512) * 512, -1024));
    const header = record.subarray(0, 512);
    header.fill(0, 0, 100); header.write(path, 0, 100);
    header.fill(0, 345, 500); header.write(kind, 156, 1);
    header.fill(0, 157, 257); header.write(link, 157, 100);
    header.fill(32, 148, 156);
    header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    return record;
  }), Buffer.alloc(1024)]);
}

test('base closure requires inspected bytes and reserves the application root', () => {
  const records = [
    { path: 'bin/sh', mode: 0o755, bytes: Buffer.from('shell') },
    { path: 'usr/bin/dirname', mode: 0o755, bytes: Buffer.from('utility') },
    { path: 'etc/ssl/certs/ca-certificates.crt', bytes: Buffer.from('certificate') },
  ];
  const entries = inspectBaseLayer(baseLayer(records));
  const result = verifyNativeV5BaseClosure(entries);
  assert.equal(result.runtime.length, 3);
  assert.equal(result.runtimeQualified, false);
  assert.equal(result.awsImageQualified, false);
  assert.throws(() => verifyNativeV5BaseClosure(new Map(entries)), /Inspected base filesystem required/);
  for (const path of ['opt', 'opt/shop', 'opt/shop/retained']) {
    const changed = inspectBaseLayer(baseLayer([...records, { path, bytes: Buffer.from('unexpected base payload') }]));
    assert.throws(() => verifyNativeV5BaseClosure(changed), /application root must be absent/);
  }
});

test('base tar accepts Debian multiarch filenames while portable locators remain strict', () => {
  const path = 'var/lib/dpkg/info/gcc-14-base:amd64.list', bytes = Buffer.from('/usr/share/doc/gcc-14-base\n');
  const entries = inspectBaseLayer(baseLayer([{ path, bytes }]));
  assert.deepEqual(entries.get(path), { kind: '0', mode: 0o644, sha256: sha256(bytes), bytes: bytes.length });
  assert.throws(() => pathName(path), /Malformed relative path/);
  for (const path of ['usr/share/name#part', 'usr/share/name?part', 'usr/share/name%2Fpart', 'usr/share/name\\x2dpart', 'usr/share/name\npart']) {
    assert.ok(inspectBaseLayer(baseLayer([{ path, bytes }])).has(path));
    assert.throws(() => pathName(path), /Malformed relative path/);
  }
});

test('base tar keeps POSIX member confinement, PAX paths and whiteout semantics', () => {
  for (const path of ['/escape', '../escape', 'a/../escape', 'a/./escape', 'a//escape']) {
    assert.throws(() => inspectBaseLayer(baseLayer([{ path }])), /relative path/);
  }
  const paxPath = 'var/lib/dpkg/info/libc6:amd64.list', data = `path=${paxPath}\n`;
  let length = Buffer.byteLength(data) + 2;
  while (Buffer.byteLength(`${length} ${data}`) !== length) length = Buffer.byteLength(`${length} ${data}`);
  const entries = inspectBaseLayer(baseLayer([
    { path: 'pax-header', kind: 'x', bytes: Buffer.from(`${length} ${data}`) },
    { path: 'placeholder', bytes: Buffer.from('libc6') },
  ]));
  assert.ok(entries.has(paxPath)); assert.equal(entries.has('placeholder'), false);
  inspectBaseLayer(baseLayer([{ path: 'var/lib/dpkg/info/.wh.libc6:amd64.list' }]), entries);
  assert.equal(entries.has(paxPath), false);
  entries.set(paxPath, { kind: '0' }); entries.set('var/lib/dpkg/info/child/file', { kind: '0' });
  entries.set('var/lib/dpkg/elsewhere', { kind: '0' });
  inspectBaseLayer(baseLayer([{ path: 'var/lib/dpkg/info/.wh..wh..opq' }]), entries);
  assert.deepEqual([...entries.keys()], ['var/lib/dpkg/elsewhere']);
});

function fixtureWithBaseRecords(records) {
  const input = fixture(), documents = new Map(), layer = baseLayer(records);
  const put = (mediaType, bytes) => {
    const digest = sha256(bytes); documents.set(`base/blobs/sha256/${digest}`, bytes);
    return { mediaType, digest: `sha256:${digest}`, size: bytes.length };
  };
  const config = put('application/vnd.oci.image.config.v1+json', Buffer.from(canonical({
    architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [`sha256:${sha256(layer)}`] },
  })));
  const manifest = put('application/vnd.oci.image.manifest.v1+json', Buffer.from(canonical({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config,
    layers: [put('application/vnd.oci.image.layer.v1.tar', layer)],
  })));
  documents.set('base/index.json', Buffer.from(canonical({ schemaVersion: 2, manifests: [{ ...manifest, platform: { architecture: 'amd64', os: 'linux' } }] })));
  documents.set('base/oci-layout', Buffer.from(canonical({ imageLayoutVersion: '1.0.0' })));
  input.base = {
    artifact: { component: 'native', format: 'oci-layout', root: 'base', entrypoint: 'base/index.json',
      files: [...documents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) },
    readFile: async ref => documents.get(ref.path), imageDigest: manifest.digest.slice(7), configDigest: config.digest.slice(7),
  };
  return input;
}

test('base runtime resolves confined POSIX links and preserves directory, cycle and escape checks', async () => {
  const records = [
    { path: 'usr', kind: '5', mode: 0o755 },
    { path: 'usr/bin', kind: '5', mode: 0o755 },
    { path: 'bin/sh', kind: '2', link: '../usr/bin/sh:amd64%\\x2d' },
    { path: 'usr/bin/sh:amd64%\\x2d', mode: 0o755, bytes: Buffer.from('shell') },
    { path: 'usr/bin/dirname', kind: '1', link: 'usr/bin/coreutils:amd64%\\x2d' },
    { path: 'usr/bin/coreutils:amd64%\\x2d', mode: 0o755, bytes: Buffer.from('dirname') },
    { path: 'etc/ssl/certs/ca-certificates.crt', kind: '2', link: '/usr/share/ca-certificates/root.crt' },
    { path: 'usr/share/ca-certificates/root.crt', bytes: Buffer.from('certificate') },
  ];
  const result = await createNativeV5Oci(fixtureWithBaseRecords(records));
  assert.equal(result.receipt.runtimeQualified, false); assert.equal(result.receipt.awsImageQualified, false);
  const changed = (path, change) => records.map(record => record.path === path ? { ...record, ...change } : record);
  await assert.rejects(createNativeV5Oci(fixtureWithBaseRecords(changed('bin/sh', { link: '../../escape' }))), /relative path/);
  await assert.rejects(createNativeV5Oci(fixtureWithBaseRecords(changed('bin/sh', { link: 'sh' }))), /link cycle/);
  await assert.rejects(createNativeV5Oci(fixtureWithBaseRecords(changed('usr/bin', { mode: 0o644 }))), /not traversable/);
  await assert.rejects(createNativeV5Oci(fixtureWithBaseRecords(changed('usr/bin/sh:amd64%\\x2d', { mode: 0o644 }))), /runtime closure/);
});

function pax(path, key = 'path') {
  const data = Buffer.concat([Buffer.from(`${key}=`), Buffer.isBuffer(path) ? path : Buffer.from(path), Buffer.from('\n')]);
  let length = data.length + 2;
  while (Buffer.byteLength(`${length} `) + data.length !== length) length = Buffer.byteLength(`${length} `) + data.length;
  return { path: 'pax-header', kind: 'x', bytes: Buffer.concat([Buffer.from(`${length} `), data]) };
}
function checksum(header) {
  header.fill(32, 148, 156);
  header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
}

test('base UTF-8 contract preserves literal systemd names, controls and BOM without decoding aliases', () => {
  const path = String.raw`usr/lib/systemd/system/system-systemd\x2dcryptsetup.slice`;
  const bytes = Buffer.from('systemd unit'), entries = inspectBaseLayer(baseLayer([{ path, bytes }]));
  assert.equal(entries.get(path)?.sha256, sha256(bytes));
  assert.equal(entries.has('usr/lib/systemd/system/system-systemd-cryptsetup.slice'), false);
  for (const path of ['utf8/caf\u00e9', 'utf8/\ufeffname', 'utf8/line\nname', 'utf8/control\u0001name', String.raw`utf8/percent%2F..\name`]) {
    const result = inspectBaseLayer(baseLayer([pax(path), { path: 'placeholder', bytes }]));
    assert.equal(result.get(path)?.sha256, sha256(bytes));
  }
  const bad = baseLayer([{ path: 'invalid-utf8' }]); bad[0] = 0xff; checksum(bad.subarray(0, 512));
  assert.throws(() => inspectBaseLayer(bad), /Invalid base UTF-8/);
  const badPax = baseLayer([pax('name'), { path: 'placeholder' }]); badPax[520] = 0xff;
  assert.throws(() => inspectBaseLayer(badPax), /Invalid base UTF-8/);
  for (const path of ['nul\0name', 'part/' + 'a'.repeat(256), 'a/'.repeat(257) + 'x', 'x'.repeat(4097)]) {
    assert.throws(() => inspectBaseLayer(baseLayer([pax(path), { path: 'placeholder' }])));
  }
  for (const path of ['/absolute', '../escape', 'a/../escape', 'a//empty']) {
    assert.throws(() => inspectBaseLayer(baseLayer([pax(path), { path: 'placeholder' }])), /relative path/);
  }
});

test('base PAX interprets names as UTF-8 while preserving opaque binary extended attributes', () => {
  const capability = Buffer.from('0100000200148000000000000000000000000000', 'hex');
  const path = 'usr/lib/gstreamer-1.0/gst-ptp-helper', payload = Buffer.from('executable');
  const metadata = pax(capability, 'SCHILY.xattr.security.capability');
  const layer = baseLayer([metadata, { path, bytes: payload }]), original = sha256(layer);
  const entries = inspectBaseLayer(layer);
  assert.equal(entries.get(path)?.sha256, sha256(payload));
  assert.equal(sha256(layer), original);
  for (const key of ['path', 'linkpath', 'size']) {
    assert.throws(() => inspectBaseLayer(baseLayer([pax(capability, key), { path }])), /UTF-8|PAX/);
    assert.throws(() => inspectBaseLayer(baseLayer([pax(Buffer.from('nul\0name'), key), { path }])), /PAX/);
  }
  const duplicate = { ...metadata, bytes: Buffer.concat([metadata.bytes, metadata.bytes]) };
  assert.throws(() => inspectBaseLayer(baseLayer([duplicate, { path }])), /Duplicate/);
  const malformedLength = { ...metadata, bytes: Buffer.from(metadata.bytes) };
  malformedLength.bytes[0] |= 0x80;
  assert.throws(() => inspectBaseLayer(baseLayer([malformedLength, { path }])), /PAX record/);
});

for (const markerFirst of [false, true]) test(`whiteouts affect only lower members with markerFirst=${markerFirst}`, () => {
  const entries = inspectBaseLayer(baseLayer([
    { path: 'dir', kind: '5', mode: 0o755 }, { path: 'dir/lower', bytes: Buffer.from('old') },
    { path: 'outside', bytes: Buffer.from('outside') },
  ]));
  const marker = { path: 'dir/.wh..wh..opq' }, addition = { path: 'dir/new', bytes: Buffer.from('new') };
  inspectBaseLayer(baseLayer(markerFirst ? [marker, addition] : [addition, marker]), entries);
  assert.equal(entries.has('dir/lower'), false); assert.equal(entries.get('dir/new')?.sha256, sha256(addition.bytes));
  assert.ok(entries.has('dir')); assert.ok(entries.has('outside'));
  const replacement = { path: 'dir/new', bytes: Buffer.from('replacement') }, remove = { path: 'dir/.wh.new' };
  inspectBaseLayer(baseLayer(markerFirst ? [remove, replacement] : [replacement, remove]), entries);
  assert.equal(entries.get('dir/new')?.sha256, sha256(replacement.bytes));
});

test('root opacity, subtree whiteouts and file/directory/link replacement retain effective ancestors', () => {
  const entries = inspectBaseLayer(baseLayer([{ path: 'old/child', bytes: Buffer.from('old') }]));
  inspectBaseLayer(baseLayer([{ path: 'new', bytes: Buffer.from('new') }, { path: '.wh..wh..opq' }]), entries);
  assert.deepEqual([...entries.keys()], ['new']);
  inspectBaseLayer(baseLayer([{ path: '.wh.new' }, { path: 'new', kind: '5', mode: 0o755 }, { path: 'new/child', bytes: Buffer.from('child') }]), entries);
  assert.ok(entries.has('new/child'));
  inspectBaseLayer(baseLayer([{ path: 'new', bytes: Buffer.from('file') }]), entries);
  assert.equal(entries.has('new/child'), false); assert.equal(entries.get('new')?.kind, '0');
  const before = new Map(entries);
  assert.throws(() => inspectBaseLayer(baseLayer([{ path: 'new/escape', bytes: Buffer.from('child') }]), entries), /ancestor is not a directory/);
  assert.deepEqual(entries, before);
  inspectBaseLayer(baseLayer([{ path: 'new', kind: '5', mode: 0o755 }, { path: 'new/child', bytes: Buffer.from('child') }]), entries);
  inspectBaseLayer(baseLayer([{ path: 'new', kind: '2', link: 'elsewhere' }]), entries);
  assert.equal(entries.has('new/child'), false); assert.equal(entries.get('new')?.kind, '2');
  inspectBaseLayer(baseLayer([{ path: '.wh.new' }]), entries); assert.equal(entries.size, 0);
});

test('base inspector fails closed on framing, PAX, whiteout and aggregate resource bounds', () => {
  const layer = baseLayer([{ path: 'a', bytes: Buffer.from('a') }, { path: 'b', bytes: Buffer.from('b') }]);
  for (const limits of [{ layerBytes: 512 }, { members: 1 }, { entries: 1 }, { nameBytes: 1 }, { treeSteps: 1 }, { treeNodes: 1 }]) {
    assert.throws(() => inspectBaseLayer(layer, new Map(), limits), /bound/);
  }
  for (const limits of [{ pathBytes: 2 }, { componentBytes: 1 }, { components: 1 }]) {
    assert.throws(() => inspectBaseLayer(baseLayer([{ path: 'a/bb' }]), new Map(), limits), /bound/);
  }
  assert.throws(() => inspectBaseLayer(layer, new Map(), { entries: 300001 }), /only tighten/);
  const entries = inspectBaseLayer(baseLayer([{ path: 'a' }]));
  assert.throws(() => inspectBaseLayer(baseLayer([{ path: 'b' }]), entries, { layers: 1 }), /Aggregate base decompression/);
  assert.throws(() => inspectBaseLayer(baseLayer([{ path: 'b' }]), entries, { totalBytes: 2048 }), /Aggregate base decompression/);
  const metadata = baseLayer([pax('a'), { path: 'placeholder' }]);
  assert.throws(() => inspectBaseLayer(metadata, new Map(), { paxBytes: 1 }), /PAX metadata bound/);
  assert.throws(() => inspectBaseLayer(metadata, new Map(), { metadataBytes: 1 }), /metadata bound/);
  assert.throws(() => inspectBaseLayer(metadata.subarray(0, -512)), /terminator/);
  const trailing = Buffer.from(layer); trailing[trailing.length - 1] = 1;
  assert.throws(() => inspectBaseLayer(trailing), /trailing bytes/);
  assert.throws(() => inspectBaseLayer(baseLayer([pax('a') ])), /PAX target/);
  assert.throws(() => inspectBaseLayer(baseLayer([pax('a'), pax('b'), { path: 'placeholder' }])), /PAX metadata bound or target/);
  assert.throws(() => inspectBaseLayer(baseLayer([{ path: '.wh.a', bytes: Buffer.from('payload') }])), /empty regular/);
  assert.throws(() => inspectBaseLayer(baseLayer([{ path: '.wh.' }])), /Empty base whiteout/);
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
