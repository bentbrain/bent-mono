import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { canonical, check, pathName, sha256 } from '../release-v2/data.mjs';
import { ociLayerBytes, verifyOciLayout } from '../release-v2/oci-layout.mjs';

const layerType = 'application/vnd.oci.image.layer.v1.tar';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const prefix = 'opt/shop';
const nativeV5Entrypoint = ['/opt/shop/runtime/lib/ld-linux-x86-64.so.2', '--library-path', '/opt/shop/runtime/lib', '/opt/shop/runtime/bin/node.real', '/opt/shop/runtime/products/shop/workers/video-renderer/aws-lambda/native-v5-runtime.mjs'];
const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;

/** Sorted USTAR regular files only; host uid, gid, umask and clock never enter the layer. */
export function nativeV5Layer(files) {
  check(Array.isArray(files) && files.length > 0 && files.length <= 8192, 'Complete bounded native layer required');
  const ordered = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  check(new Set(ordered.map(file => file.path)).size === ordered.length, 'Duplicate native layer path');
  for (const file of ordered) {
    pathName(file.path); check(file.path.startsWith(`${prefix}/`) && !file.path.split('/').some(part => part.startsWith('.wh.')) &&
      Buffer.isBuffer(file.bytes) && [0o644, 0o755].includes(file.mode), 'Native layer requires confined regular bytes and normalized modes');
  }
  const directories = [...new Set(ordered.flatMap(file => file.path.split('/').slice(0, -1).map((_part, index, parts) => parts.slice(0, index + 1).join('/'))))].sort();
  check(directories.length <= 16384, 'Native directory inventory exceeds bound');
  const records = [...directories.map(path => ({ path, bytes: Buffer.alloc(0), mode: 0o755, kind: '5' })), ...ordered];
  let total = 1024;
  const chunks = [];
  for (const file of records) {
    const parts = file.path.split('/'); let name = parts.pop(), directory = parts.join('/');
    while (Buffer.byteLength(name) <= 100 && Buffer.byteLength(directory) > 155 && parts.length) { name = `${parts.pop()}/${name}`; directory = parts.join('/'); }
    check(Buffer.byteLength(name) <= 100 && Buffer.byteLength(directory) <= 155, 'Native USTAR path is too long');
    const header = Buffer.alloc(512); header.write(name, 0, 100); header.write(octal(file.mode, 8), 100); header.write(octal(0, 8), 108); header.write(octal(0, 8), 116);
    header.write(octal(file.bytes.length, 12), 124); header.write(octal(0, 12), 136); header.fill(32, 148, 156); header.write(file.kind ?? '0', 156);
    header.write('ustar\0', 257); header.write('00', 263); header.write(directory, 345, 155);
    header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    const padding = Buffer.alloc((512 - file.bytes.length % 512) % 512);
    total += 512 + file.bytes.length + padding.length; check(total <= 512 * 1024 * 1024, 'Native application layer exceeds the retained object bound');
    chunks.push(header, file.bytes, padding);
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)], total);
}

// Inspect base tar records in memory. No base member is extracted on the host.
export function inspectBaseLayer(bytes, entries = new Map()) {
  let pending = {}, ended = false;
  const string = value => value.toString('utf8').replace(/\0.*$/s, '');
  const number = value => { const text = string(value).trim(); check(/^[0-7]*$/.test(text), 'Unsupported tar number'); return Number.parseInt(text || '0', 8); };
  for (let offset = 0; offset < bytes.length;) {
    check(offset + 512 <= bytes.length, 'Truncated base tar header');
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) { check(bytes.subarray(offset).every(byte => byte === 0), 'Base tar has bytes after terminator'); ended = true; break; }
    const checksum = number(header.subarray(148, 156)), copy = Buffer.from(header); copy.fill(32, 148, 156);
    check([...copy].reduce((sum, byte) => sum + byte, 0) === checksum, 'Base tar checksum differs');
    const size = number(header.subarray(124, 136)); check(Number.isSafeInteger(size) && size >= 0 && offset + Math.ceil(size / 512) * 512 <= bytes.length, 'Truncated base tar payload');
    const content = bytes.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const kind = string(header.subarray(156, 157)) || '0';
    if (kind === 'x') {
      let at = 0; pending = {};
      while (at < content.length) { const space = content.indexOf(32, at), length = Number(content.subarray(at, space).toString());
        check(space > at && Number.isSafeInteger(length) && length > 0 && at + length <= content.length, 'Invalid base PAX record');
        const record = content.subarray(space + 1, at + length - 1).toString('utf8'), equal = record.indexOf('='); check(equal > 0, 'Invalid base PAX field');
        const key = record.slice(0, equal); check(!Object.hasOwn(pending, key), 'Duplicate base PAX field'); pending[key] = record.slice(equal + 1); at += length; }
      continue;
    }
    check(['0', '1', '2', '5'].includes(kind), 'Unsupported base tar member');
    let path = pending.path ?? [string(header.subarray(345, 500)), string(header.subarray(0, 100))].filter(Boolean).join('/');
    path = path.replace(/^\.\//, '').replace(/\/$/, '');
    if (path === '.' || path === '') { check(kind === '5', 'Invalid base root member'); pending = {}; continue; }
    pathName(path); const link = pending.linkpath ?? string(header.subarray(157, 257));
    check(pending.size === undefined || pending.size === String(size), 'PAX size differs'); pending = {};
    const leaf = posix.basename(path), directory = posix.dirname(path);
    if (leaf === '.wh..wh..opq') { for (const key of entries.keys()) if (key.startsWith(`${directory}/`)) entries.delete(key); }
    else if (leaf.startsWith('.wh.')) { const removed = posix.join(directory, leaf.slice(4)); for (const key of entries.keys()) if (key === removed || key.startsWith(`${removed}/`)) entries.delete(key); }
    else entries.set(path, { kind, mode: number(header.subarray(100, 108)), ...(kind === '0' ? { sha256: sha256(content), bytes: size } : { link }) });
  }
  check(ended && Object.keys(pending).length === 0, 'Base tar terminator or PAX target missing'); return entries;
}

function baseFile(entries, input) {
  let path = input;
  for (let count = 0; count < 32; count++) {
    const parts = path.split('/'); let redirected = false;
    for (let index = 1; index <= parts.length; index++) {
      const key = parts.slice(0, index).join('/'), item = entries.get(key);
      if (item && item.kind === '5') check((item.mode & 0o001) === 0o001, 'Base runtime directory is not traversable by the Lambda user');
      if (item && ['1', '2'].includes(item.kind)) {
        const target = item.link.startsWith('/') ? item.link.slice(1) : item.kind === '1' ? item.link : posix.join(posix.dirname(key), item.link);
        path = posix.normalize(posix.join(target, ...parts.slice(index))); pathName(path); redirected = true; break;
      }
    }
    if (!redirected) return entries.get(path);
  }
  throw Error('Base runtime link cycle');
}

/** The caller supplies an authenticated pinned base graph, never an image tag. */
export async function createNativeV5Oci({ base, files, identity, candidateReceipt, sourceInventory }) {
  check(base && /^[a-f0-9]{64}$/.test(base.imageDigest) && /^[a-f0-9]{64}$/.test(base.configDigest), 'Pinned complete base OCI input required');
  const graph = await verifyOciLayout(base);
  check(graph.imageDigest === base.imageDigest && graph.configDescriptor.digest === `sha256:${base.configDigest}` && graph.architecture === 'amd64' && graph.layers > 0, 'Pinned base image/config/platform differs');
  const entries = new Map();
  for (let index = 0; index < graph.layers; index++) inspectBaseLayer(ociLayerBytes(graph.layerDescriptors[index].mediaType, await base.readFile(graph.descriptorRefs.layers[index])), entries);
  check(![...entries.keys()].some(path => path === 'opt/shop' || path.startsWith('opt/shop/')) && (!entries.has('opt') || entries.get('opt').kind === '5'), 'Native application root must be absent from the pinned base');
  for (const path of ['bin/sh', 'usr/bin/dirname', 'etc/ssl/certs/ca-certificates.crt']) {
    const file = baseFile(entries, path); check(file?.kind === '0' && file.bytes > 0 && (file.mode & 0o004) === 0o004 && (path.startsWith('etc/') || (file.mode & 0o001) === 0o001), 'Base shell, core utility or CA runtime closure is missing');
  }
  check(identity?.schema === 'shop.native-v5-image-input/v1' && /^[a-f0-9]{40}$/.test(identity.sourceCommit) &&
    ['candidateManifestSha256', 'capsuleManifestSha256', 'runtimeFilesSha256', 'sourceInventorySha256'].every(key => /^[a-f0-9]{64}$/.test(identity[key])), 'Exact native source/capsule/runtime identity required');
  check(Array.isArray(files) && files.every(file => file.path.startsWith('runtime/') || file.path.startsWith('native-image/')), 'Native application input path differs');
  const required = ['runtime/bin/node.real', 'runtime/bin/ffmpeg', 'runtime/bin/ffprobe', 'runtime/lib/ld-linux-x86-64.so.2', 'native-image/product-image-v5-entry.mjs', 'native-image/capsule-manifest.json',
    'runtime/products/shop/workers/video-renderer/aws-lambda/native-v5-runtime.mjs', 'runtime/products/shop/workers/video-renderer/aws-lambda/app-entry.mjs', 'runtime/products/shop/workers/video-renderer/aws-lambda/failure-entry.mjs'];
  check(required.every(path => files.some(file => file.path === path && file.bytes.length > 0)), 'Complete native entrypoint/compatibility/runtime input required');
  check(Buffer.isBuffer(candidateReceipt) && sha256(candidateReceipt) === identity.candidateManifestSha256 && Buffer.isBuffer(sourceInventory) && sha256(sourceInventory) === identity.sourceInventorySha256, 'Native candidate/source receipt bytes differ');
  const candidate = JSON.parse(candidateReceipt.toString('utf8')), capsuleBytes = files.find(file => file.path === 'native-image/capsule-manifest.json').bytes;
  check(sha256(capsuleBytes) === identity.capsuleManifestSha256 && candidate.capsuleManifestSha256 === identity.capsuleManifestSha256 && candidate.runtimeFilesSha256 === identity.runtimeFilesSha256 && candidate.sourceInventorySha256 === identity.sourceInventorySha256 && candidate.sourceCommit === identity.sourceCommit && candidate.awsImageQualified === false, 'Native capsule/candidate identity differs');
  const actualRuntime = files.filter(file => file.path.startsWith('runtime/')).map(file => ({ path: file.path.slice(8), bytes: file.bytes.length, sha256: sha256(file.bytes), executable: file.mode === 0o755 })).sort((a, b) => a.path < b.path ? -1 : 1);
  check(canonical(actualRuntime) === canonical([...candidate.runtimeFiles].sort((a, b) => a.path < b.path ? -1 : 1)) && sha256(JSON.stringify(candidate.runtimeFiles, null, 2) + '\n') === identity.runtimeFilesSha256, 'Native runtime inventory differs');
  const capsule = JSON.parse(capsuleBytes.toString('utf8')), actualCapsule = files.filter(file => file.path.startsWith('native-image/') && file.path !== 'native-image/capsule-manifest.json').map(file => ({ path: file.path.slice(13), size: file.bytes.length, sha256: sha256(file.bytes) })).sort((a, b) => a.path < b.path ? -1 : 1);
  check(canonical(actualCapsule) === canonical([...capsule.files].sort((a, b) => a.path < b.path ? -1 : 1)) && sha256(JSON.stringify(capsule.files)) === capsule.filesSha256, 'Native capsule inventory differs');
  for (const path of ['runtime/bin/node.real', 'runtime/lib/ld-linux-x86-64.so.2']) {
    const binary = files.find(file => file.path === path);
    check(binary.mode === 0o755 && binary.bytes.length >= 64 && binary.bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) && binary.bytes.readUInt16LE(18) === 62, 'Native Linux amd64 ELF runtime required');
  }
  const payloadFiles = files.map(file => ({ ...file, path: `${prefix}/${file.path}` }));
  const objects = new Map();
  const put = (mediaType, bytes) => { const digest = sha256(bytes); objects.set(`blobs/sha256/${digest}`, bytes); return { mediaType, digest: `sha256:${digest}`, size: bytes.length }; };
  for (const ref of base.artifact.files.filter(file => file.path.includes('/blobs/sha256/'))) objects.set(`blobs/sha256/${posix.basename(ref.path)}`, await base.readFile(ref));
  // The old base manifest/config remain inputs, not unreferenced final graph objects.
  objects.delete(`blobs/sha256/${graph.manifestDescriptor.digest.slice(7)}`); objects.delete(`blobs/sha256/${graph.configDescriptor.digest.slice(7)}`);
  const groups = []; let group = [], groupBytes = 1024;
  for (const file of [...payloadFiles].sort((a, b) => a.path < b.path ? -1 : 1)) {
    const size = 512 + Math.ceil(file.bytes.length / 512) * 512;
    if (group.length && groupBytes + size > 128 * 1024 * 1024) { groups.push(group); group = []; groupBytes = 1024; }
    group.push(file); groupBytes += size;
  }
  if (group.length) groups.push(group);
  const applicationLayers = groups.map(files => put(layerType, nativeV5Layer(files)));
  const configuration = { architecture: 'amd64', os: 'linux', config: { Entrypoint: nativeV5Entrypoint, Cmd: [], WorkingDir: '/opt/shop/runtime',
    Env: ['PATH=/opt/shop/runtime/bin:/usr/local/bin:/usr/bin:/bin', 'LD_LIBRARY_PATH=/opt/shop/runtime/lib', 'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt', 'NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt', 'TMPDIR=/tmp'] },
    rootfs: { type: 'layers', diff_ids: [...graph.configuration.rootfs.diff_ids, ...applicationLayers.map(layer => layer.digest)] }, history: [...(graph.configuration.history ?? []), ...applicationLayers.map(() => ({ created_by: 'shop-native-v5-oci/v1' }))] };
  const config = put(configType, Buffer.from(canonical(configuration)));
  const manifest = { schemaVersion: 2, mediaType: manifestType, config, layers: [...graph.layerDescriptors, ...applicationLayers] };
  const image = put(manifestType, Buffer.from(canonical(manifest)));
  objects.set('oci-layout', Buffer.from(canonical({ imageLayoutVersion: '1.0.0' })));
  objects.set('index.json', Buffer.from(canonical({ schemaVersion: 2, manifests: [{ ...image, platform: { architecture: 'amd64', os: 'linux' } }] })));
  const root = 'payload/native', artifact = { component: 'native', format: 'oci-layout', root, entrypoint: `${root}/index.json`,
    files: [...objects].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path: `${root}/${path}`, bytes: bytes.length, sha256: sha256(bytes) })) };
  const result = await verifyOciLayout({ artifact, readFile: async ref => objects.get(ref.path.slice(root.length + 1)) });
  const inventory = payloadFiles.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes), mode: file.mode })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { artifact, files: objects, graph: result, receipt: { schema: 'shop.native-v5-oci-receipt/v1', identity, baseImageDigest: base.imageDigest, baseConfigDigest: base.configDigest,
    baseManifest: (await base.readFile(graph.descriptorRefs.manifest)).toString('base64'), baseConfiguration: (await base.readFile(graph.descriptorRefs.config)).toString('base64'),
    imageDigest: result.imageDigest, configDigest: config.digest.slice(7), applicationLayerDigests: applicationLayers.map(layer => layer.digest.slice(7)), inventory, inventorySha256: sha256(canonical(inventory)), directoryMode: '0755',
    entrypoint: nativeV5Entrypoint, platform: { os: 'linux', architecture: 'amd64' }, dataLayoutVerified: true, runtimeQualified: false, awsImageQualified: false } };
}

/** Prove the receipt describes the actual retained application layers, never a locator. */
export async function verifyNativeV5OciReceipt({ graph, readFile, receipt }) {
  check(receipt?.schema === 'shop.native-v5-oci-receipt/v1' && receipt.awsImageQualified === false && receipt.runtimeQualified === false && receipt.dataLayoutVerified === true &&
    graph.imageDigest === receipt.imageDigest && graph.configDescriptor.digest === `sha256:${receipt.configDigest}`, 'Native OCI receipt image identity differs');
  const baseManifestBytes = Buffer.from(receipt.baseManifest ?? '', 'base64'), baseConfigBytes = Buffer.from(receipt.baseConfiguration ?? '', 'base64');
  check(sha256(baseManifestBytes) === receipt.baseImageDigest && sha256(baseConfigBytes) === receipt.baseConfigDigest, 'Pinned native OCI base receipt differs');
  const baseManifest = JSON.parse(baseManifestBytes.toString('utf8')), baseConfig = JSON.parse(baseConfigBytes.toString('utf8'));
  const baseCount = baseManifest.layers?.length;
  check(Number.isSafeInteger(baseCount) && baseCount > 0 && baseManifest.config?.digest === `sha256:${receipt.baseConfigDigest}` && baseManifest.config.size === baseConfigBytes.length &&
    canonical(graph.layerDescriptors.slice(0, baseCount)) === canonical(baseManifest.layers) &&
    canonical(graph.configuration.rootfs.diff_ids.slice(0, baseCount)) === canonical(baseConfig.rootfs?.diff_ids), 'Native OCI base layer graph differs');
  check(Array.isArray(receipt.applicationLayerDigests) && receipt.applicationLayerDigests.length > 0 && graph.layers === baseCount + receipt.applicationLayerDigests.length &&
    canonical(graph.layerDescriptors.slice(baseCount).map(layer => layer.digest.slice(7))) === canonical(receipt.applicationLayerDigests) &&
    canonical(graph.configuration.config.Entrypoint) === canonical(nativeV5Entrypoint), 'Native OCI application/runtime graph differs');
  const entries = new Map();
  for (let index = baseCount; index < graph.layers; index++) {
    const layer = graph.layerDescriptors[index]; check(layer.mediaType === layerType, 'Native application layer encoding differs');
    const current = inspectBaseLayer(await readFile(graph.descriptorRefs.layers[index]));
    for (const [path, value] of current) {
      if (value.kind === '5') { check((path === 'opt' || path === prefix || path.startsWith(`${prefix}/`)) && value.mode === 0o755, 'Native OCI directory mode differs'); continue; }
      check(path.startsWith(`${prefix}/`) && value.kind === '0' && [0o644, 0o755].includes(value.mode) && !entries.has(path), 'Native OCI application member differs'); entries.set(path, value); }
  }
  check(receipt.directoryMode === '0755', 'Native OCI directory policy differs');
  const inventory = [...entries].map(([path, value]) => ({ path, bytes: value.bytes, sha256: value.sha256, mode: value.mode })).sort((a, b) => a.path < b.path ? -1 : 1);
  check(canonical(inventory) === canonical(receipt.inventory) && sha256(canonical(inventory)) === receipt.inventorySha256, 'Native OCI application inventory differs');
  return { imageDigest: graph.imageDigest, inventory, inventorySha256: receipt.inventorySha256, runtimeQualified: false, awsImageQualified: false };
}

export async function writeNativeV5Oci(result, destination) {
  check(result?.receipt?.awsImageQualified === false && result.receipt.runtimeQualified === false, 'Unqualified producer receipt required');
  await mkdir(destination, { mode: 0o700 });
  for (const [path, bytes] of result.files) { pathName(path); await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 }); await writeFile(join(destination, path), bytes, { mode: 0o600, flag: 'wx' }); }
  return { directory: destination, receipt: result.receipt, imageDigest: result.graph.imageDigest };
}
