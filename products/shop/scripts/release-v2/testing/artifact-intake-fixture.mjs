// Synthetic original-format encrypted GitHub artifacts. These bytes qualify no cloud target.
import { generateKeyPairSync, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { sealLinuxEvidence } from '../../testing/linux-evidence.mjs';
import { sha256 } from '../data.mjs';
import { createPortableFixture } from './portable-fixture.mjs';

const table = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
const fixtureCRC32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; };
const octal = (value, length) => Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`);

function fixtureTarRecord({ path, data = Buffer.alloc(0), mode = 0o600, type = '0', link = '' }) {
  const bytes = Buffer.from(data), header = Buffer.alloc(512);
  checkLength(path, 100); header.write(path); octal(mode, 8).copy(header, 100); octal(0, 8).copy(header, 108); octal(0, 8).copy(header, 116);
  octal(bytes.length, 12).copy(header, 124); octal(0, 12).copy(header, 136); header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157);
  header.write('ustar ', 257); header.write(' \0', 263);
  const sum = header.reduce((total, byte) => total + byte, 0); header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function checkLength(value, bound) { if (Buffer.byteLength(value) > bound) throw Error('Fixture path exceeds fixed field'); }
export function fixtureTar(entries) {
  const records = [];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.path) > 100) { records.push(fixtureTarRecord({ path: '././@LongLink', type: 'L', data: Buffer.from(`${entry.path}\0`) })); records.push(fixtureTarRecord({ ...entry, path: entry.path.slice(0, 80) })); }
    else records.push(fixtureTarRecord(entry));
  }
  return Buffer.concat([...records, Buffer.alloc(1024)]);
}

export function fixtureZip(entries, { descriptor = true, zip64 = false } = {}) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), compressed = Buffer.concat([deflateRawSync(data), entry.compressedTail ?? Buffer.alloc(0)]), crc = fixtureCRC32(data), header = Buffer.alloc(30), record = Buffer.alloc(46), localExtra = Buffer.alloc(zip64 ? 20 : 0), centralExtra = Buffer.alloc(zip64 ? 28 : 0);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(zip64 ? 45 : 20, 4); header.writeUInt16LE(descriptor ? 0x808 : 0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(localExtra.length, 28);
    if (!descriptor) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); }
    const descriptorPrefix = descriptor === 'unsigned' ? 0 : 4, tail = Buffer.alloc(descriptor ? descriptorPrefix + (zip64 ? 20 : 12) : 0);
    if (descriptor) { if (descriptorPrefix) tail.writeUInt32LE(0x08074b50); tail.writeUInt32LE(crc, descriptorPrefix); if (zip64) { tail.writeBigUInt64LE(BigInt(compressed.length), descriptorPrefix + 4); tail.writeBigUInt64LE(BigInt(data.length), descriptorPrefix + 12); } else { tail.writeUInt32LE(compressed.length, descriptorPrefix + 4); tail.writeUInt32LE(data.length, descriptorPrefix + 8); } }
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(zip64 ? 45 : 20, 6); record.writeUInt16LE(descriptor ? 0x808 : 0x800, 8); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? 0o100600) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42); record.writeUInt16LE(centralExtra.length, 30);
    if (zip64) {
      localExtra.writeUInt16LE(1); localExtra.writeUInt16LE(16, 2); localExtra.writeBigUInt64LE(BigInt(data.length), 4); localExtra.writeBigUInt64LE(BigInt(compressed.length), 12);
      centralExtra.writeUInt16LE(1); centralExtra.writeUInt16LE(24, 2); centralExtra.writeBigUInt64LE(BigInt(data.length), 4); centralExtra.writeBigUInt64LE(BigInt(compressed.length), 12); centralExtra.writeBigUInt64LE(BigInt(offset), 20);
      header.writeUInt32LE(0xffffffff, 18); header.writeUInt32LE(0xffffffff, 22); record.writeUInt32LE(0xffffffff, 20); record.writeUInt32LE(0xffffffff, 24); record.writeUInt32LE(0xffffffff, 42);
    }
    local.push(header, name, localExtra, compressed, tail); central.push(record, name, centralExtra); offset += header.length + name.length + localExtra.length + compressed.length + tail.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  if (zip64) {
    const record = Buffer.alloc(56), locator = Buffer.alloc(20); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32); record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16);
    end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
    return Buffer.concat([...local, directory, record, locator, end]);
  }
  return Buffer.concat([...local, directory, end]);
}

async function collect(root, prefix = '', entries = []) {
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name, info = await lstat(join(root, path));
    if (info.isDirectory()) { entries.push({ path: `shop-linux-private/${path}/`, type: '5', mode: 0o700 }); await collect(root, path, entries); }
    else entries.push({ path: `shop-linux-private/${path}`, data: await readFile(join(root, path)), mode: info.mode & 0o111 ? 0o700 : 0o600 });
  }
  return entries;
}

export async function createArtifactIntakeFixture(t, options = {}) {
  const sourceCommit = options.sourceCommit ?? '1'.repeat(40), request = { runId: options.runId ?? 123, runAttempt: options.runAttempt ?? 1, artifactId: options.artifactId ?? 789, sourceCommit }, jobId = options.jobId ?? 987;
  const workflowRef = `bentbrain/bent-mono/.github/workflows/shop-linux-journey.yml@${options.pullRequestNumber ? `refs/pull/${options.pullRequestNumber}/merge` : 'refs/heads/main'}`;
  const lineage = { kind: 'github-actions', repository: 'bentbrain/bent-mono', sourceCommit, runId: String(request.runId), runAttempt: String(request.runAttempt), workflowRef, jobId: 'journey' };
  const fixture = options.portableFixture ?? await createPortableFixture(t, { lineage, ...(options.root ? { rootDirectory: options.root } : {}) }), { root, verified } = fixture;
  const original = options.originalDirectory ?? join(root, 'original');
  if (!options.originalDirectory) {
  await mkdir(original, { mode: 0o700 });
  const bundle = join(original, 'portable-release'); await mkdir(bundle, { mode: 0o700 });
  for (const file of [...verified.manifest.files, { path: 'portable-bundle.json', mode: '0600' }]) {
    await mkdir(join(bundle, file.path, '..'), { recursive: true, mode: 0o700 }); await copyFile(join(verified.root, file.path), join(bundle, file.path)); await chmod(join(bundle, file.path), parseInt(file.mode, 8));
  }
  await writeFile(join(original, 'portable-release-identity.private.json'), JSON.stringify({ manifestSha256: verified.manifestSha256, originSourceCommit: sourceCommit, lineage, requireHostedLineage: true }), { mode: 0o600 });
  await mkdir(join(original, 'journey'), { mode: 0o700 });
  await writeFile(join(original, 'journey/linux-j01.private.json'), JSON.stringify({ schema: 'shop.linux-j01/v1', qualification: 'linux-candidate-execution', complete: true, dirtySnapshot: false,
    awsImageQualified: false, productionQualified: false, sourceCommit, portableManifestSha256: verified.manifestSha256, execution: { code: 0, signal: null, overflow: false } }), { mode: 0o600 });
  }
  const privateKeyFile = options.recipientPrivateKeyFile ?? join(root, 'recipient.private.pem');
  const keypair = options.recipientPrivateKeyFile ? { privateKey: createPrivateKey(await readFile(privateKeyFile)) } : generateKeyPairSync('rsa', { modulusLength: 3072 });
  keypair.publicKey ??= createPublicKey(keypair.privateKey);
  const publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
  const recipientFingerprint = createHash('sha256').update(keypair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (!options.recipientPrivateKeyFile) await writeFile(privateKeyFile, keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const entries = [{ path: 'shop-linux-private/', type: '5', mode: 0o700 }, ...(await collect(original)).filter(entry => entry.path !== 'shop-linux-private/evidence-inventory.private.json')];
  const files = entries.filter(entry => entry.type !== '5').map(entry => ({ path: entry.path.slice('shop-linux-private/'.length), bytes: entry.data.length, sha256: sha256(entry.data), executable: entry.mode === 0o700 }));
  entries.push({ path: 'shop-linux-private/evidence-inventory.private.json', mode: 0o600, data: Buffer.from(JSON.stringify({ schema: 'shop.hosted-linux-evidence/v1', sourceCommit, runId: String(request.runId), runAttempt: String(request.runAttempt), workflowRef: lineage.workflowRef, repository: lineage.repository, recipe: { synthetic: true }, files, filesSha256: sha256(JSON.stringify(files)) })) });
  const state = { archive: undefined };
  const installation = { repository: { name: 'bentbrain/bent-mono', id: 101, ownerId: 102 }, workflow: { id: 456, path: '.github/workflows/shop-linux-journey.yml', jobName: 'Built Linux J01', jobId: 'journey' }, recipientFingerprint,
    limits: { archiveBytes: 16 * 1024 ** 2, expandedBytes: 32 * 1024 ** 2, files: 4096 } };
  const repo = { id: 101, full_name: 'bentbrain/bent-mono', owner: { id: 102, login: 'bentbrain' } }, prefix = '/repos/bentbrain/bent-mono';
  const documents = {
    [prefix]: repo,
    [`${prefix}/actions/workflows/456`]: { id: 456, path: installation.workflow.path, state: 'active' },
    [`${prefix}/actions/runs/${request.runId}`]: { id: request.runId, run_attempt: request.runAttempt, workflow_id: 456, path: installation.workflow.path, status: 'completed', conclusion: 'success', head_sha: sourceCommit,
      event: options.pullRequestNumber ? 'pull_request' : 'workflow_dispatch', head_branch: 'main', ...(options.pullRequestNumber ? { pull_requests: [{ number: options.pullRequestNumber, head: { sha: sourceCommit, repo: { id: 101 } } }] } : {}), repository: repo, head_repository: repo, updated_at: '2026-11-12T00:10:00Z' },
    [`${prefix}/actions/runs/${request.runId}/attempts/${request.runAttempt}/jobs?per_page=100`]: { total_count: 1, jobs: [{ id: jobId, run_id: request.runId, run_attempt: request.runAttempt, head_sha: sourceCommit, name: 'Built Linux J01', status: 'completed', conclusion: 'success', started_at: '2026-11-12T00:00:00Z', completed_at: '2026-11-12T00:09:00Z' }] },
    [`${prefix}/actions/artifacts/${request.artifactId}`]: { id: request.artifactId, name: `shop-linux-private-${request.runId}-${request.runAttempt}`, expired: false, created_at: '2026-11-12T00:08:00Z', updated_at: '2026-11-12T00:08:30Z', workflow_run: { id: request.runId, repository_id: 101, head_repository_id: 101, head_sha: sourceCommit } },
  };
  let count = 0;
  async function sealEntries(nextEntries = entries, { gzip, zipEntries } = {}) {
    const tar = fixtureTar(nextEntries), compressed = gzip ?? gzipSync(tar), input = join(root, `plaintext-${count}.tar.gz`), sealed = join(root, `sealed-${count++}.enc`);
    await writeFile(input, compressed, { mode: 0o600 });
    await sealLinuxEvidence(input, sealed, { sourceCommit, runId: String(request.runId), filename: 'linux-evidence.json' }, { publicKeyPem, keyFingerprint: recipientFingerprint });
    const sealedEntries = await Promise.all([['linux-evidence.tar.gz.enc', sealed], ['linux-evidence.tar.gz.enc.json', `${sealed}.json`], ['linux-evidence.tar.gz.enc.envelope.json', `${sealed}.envelope.json`]].map(async ([name, path]) => ({ name, data: await readFile(path) })));
    const archive = fixtureZip(zipEntries ? zipEntries(sealedEntries) : sealedEntries);
    setArchive(archive); return { tar, compressed, sealedEntries, archive };
  }
  function setArchive(archive) { state.archive = archive; documents[`${prefix}/actions/artifacts/${request.artifactId}`].digest = `sha256:${sha256(archive)}`; documents[`${prefix}/actions/artifacts/${request.artifactId}`].size_in_bytes = archive.length; }
  const api = {
    async getJSON(endpoint) { if (!Object.hasOwn(documents, endpoint)) throw Error('Unknown synthetic artifact endpoint'); return structuredClone(documents[endpoint]); },
    async downloadArtifact({ endpoint, destination, maxBytes }) { if (endpoint !== `${prefix}/actions/artifacts/${request.artifactId}/zip` || state.archive.length > maxBytes) throw Error('Synthetic download bound differs'); await writeFile(destination, state.archive, { mode: 0o600, flag: 'wx' }); },
  };
  const initial = await sealEntries();
  return { ...fixture, request, installation, privateKeyFile, api, documents, entries, initial, sealEntries, setArchive, get archive() { return state.archive; } };
}
