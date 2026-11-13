import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { importHostedPortable, assertHostedPortableImport, createGithubArtifactApi } from './artifact-intake.mjs';
import { sha256 } from './data.mjs';
import { materializePortableBundle } from './portable-bundle.mjs';
import { createArtifactIntakeFixture, fixtureTar, fixtureZip } from './testing/artifact-intake-fixture.mjs';

const root = process.env.SHOP_ARTIFACT_INTAKE_TEST_ROOT ?? tmpdir();
const execute = promisify(execFile);
if (process.platform === 'darwin') assert.ok(root.startsWith('/Volumes/MacMiniDevelopment/'), 'Set TMPDIR or SHOP_ARTIFACT_INTAKE_TEST_ROOT to a private SSD directory');
const fixtureFor = t => createArtifactIntakeFixture(t, { root });
const copyEntries = entries => entries.map(entry => ({ ...entry, ...(entry.data ? { data: Buffer.from(entry.data) } : {}) }));
const document = (fixture, suffix) => fixture.documents[`/repos/bentbrain/bent-mono${suffix ? `/${suffix}` : ''}`];
let sequence = 0;
const run = (fixture, overrides = {}) => importHostedPortable({ ...fixture, destination: join(fixture.root, `import-${sequence++}`), ...overrides });

function updateInventory(entries) {
  const entry = entries.find(item => item.path === 'shop-linux-private/evidence-inventory.private.json'), inventory = JSON.parse(entry.data);
  inventory.files = entries.filter(item => item.type !== '5' && item !== entry).map(item => ({ path: item.path.slice('shop-linux-private/'.length), bytes: item.data.length, sha256: sha256(item.data), executable: item.mode === 0o700 })).sort((a, b) => a.path < b.path ? -1 : 1);
  inventory.filesSha256 = sha256(JSON.stringify(inventory.files)); entry.data = Buffer.from(JSON.stringify(inventory));
}

test('original encrypted Actions archive retains all components and refreshes branded admission', async t => {
  const fixture = await fixtureFor(t), before = sha256(fixture.archive), result = await run(fixture);
  assert.equal(result.portable.manifestSha256, fixture.verified.manifestSha256);
  assert.deepEqual([...result.portable.components.keys()], ['business', 'native', 'storefront']);
  assert.equal(result.awsImageQualified, false);
  assert.equal((await lstat(result.portable.root)).mode & 0o777, 0o700);
  assert.equal((await assertHostedPortableImport(result)).portable.manifestSha256, fixture.verified.manifestSha256);
  assert.equal((await assertHostedPortableImport(result, { installation: fixture.installation, sourceCommit: fixture.request.sourceCommit })).awsImageQualified, false);
  await assert.rejects(assertHostedPortableImport(result, { installation: { ...fixture.installation, recipientFingerprint: 'f'.repeat(64) } }), /protected installation/);
  await assert.rejects(assertHostedPortableImport(result, { sourceCommit: '2'.repeat(40) }), /protected installation/);
  await assert.rejects(assertHostedPortableImport({ ...result }), /in-process/);
  const assembly = await materializePortableBundle(result.portable, join(fixture.root, 'assembly'));
  assert.notEqual(assembly.root, result.portable.root);
  assert.equal(sha256(fixture.archive), before);
  assert.equal((await assertHostedPortableImport(result)).awsImageQualified, false);
  const metadata = JSON.parse(await readFile(result.evidence.metadata.path)); assert.deepEqual(metadata, result.metadata);
});

test('system GNU-format tar and gzip import through the original seal helpers', async t => {
  const fixture = await fixtureFor(t), source = join(fixture.root, 'system-tar'), archive = join(fixture.root, 'system-tar.tar.gz'); await mkdir(source, { mode: 0o700 });
  for (const entry of fixture.entries) {
    if (entry.type === '5') await mkdir(join(source, entry.path), { mode: entry.mode });
    else await writeFile(join(source, entry.path), entry.data, { mode: entry.mode, flag: 'wx' });
  }
  const version = (await execute('tar', ['--version'])).stdout;
  await execute('tar', [version.includes('bsdtar') ? '--format=gnutar' : '--format=gnu', '-czf', archive, 'shop-linux-private'], { cwd: source, timeout: 30000, maxBuffer: 16384 });
  await fixture.sealEntries(fixture.entries, { gzip: await readFile(archive) });
  assert.equal((await run(fixture)).portable.manifestSha256, fixture.verified.manifestSha256);
});

test('two source releases reuse one protected recipient installation with separate exact run identities', async t => {
  const first = await fixtureFor(t), second = await createArtifactIntakeFixture(t, { root, sourceCommit: '2'.repeat(40), runId: 124, artifactId: 790, jobId: 988, recipientPrivateKeyFile: first.privateKeyFile });
  assert.deepEqual(first.installation, second.installation);
  const a = await run(first), b = await run(second);
  assert.notEqual(a.portable.manifestSha256, b.portable.manifestSha256);
  assert.equal(a.portable.lineage.runId, '123'); assert.equal(b.portable.lineage.runId, '124');
  assert.equal((await assertHostedPortableImport(b, { installation: first.installation, sourceCommit: second.request.sourceCommit })).awsImageQualified, false);
});

test('same-repository pull request lineage binds the original merge workflow ref', async t => {
  const fixture = await createArtifactIntakeFixture(t, { root, pullRequestNumber: 42 }), result = await run(fixture);
  assert.equal(result.portable.lineage.workflowRef, 'bentbrain/bent-mono/.github/workflows/shop-linux-journey.yml@refs/pull/42/merge');
  document(fixture, 'actions/runs/123').pull_requests[0].head.repo.id++;
  await assert.rejects(run(fixture), /pull request source/);
  document(fixture, 'actions/runs/123').pull_requests = [];
  assert.equal((await run(fixture)).portable.lineage.workflowRef, result.portable.lineage.workflowRef);
});

test('all repository, run, attempt, producer and original artifact metadata must authenticate before download', async t => {
  const fixture = await fixtureFor(t), baseline = structuredClone(fixture.documents);
  const cases = [
    ['repository ID', () => { document(fixture, '').id++; }],
    ['owner ID', () => { document(fixture, '').owner.id++; }],
    ['repository name', () => { document(fixture, '').full_name = 'someone/fork'; }],
    ['workflow ID', () => { document(fixture, 'actions/workflows/456').id++; }],
    ['workflow path', () => { document(fixture, 'actions/workflows/456').path = '.github/workflows/other.yml'; }],
    ['workflow state', () => { document(fixture, 'actions/workflows/456').state = 'disabled_manually'; }],
    ['stale run attempt', () => { document(fixture, 'actions/runs/123').run_attempt++; }],
    ['wrong run ID', () => { document(fixture, 'actions/runs/123').id++; }],
    ['run still running', () => { document(fixture, 'actions/runs/123').status = 'in_progress'; }],
    ['failed run', () => { document(fixture, 'actions/runs/123').conclusion = 'failure'; }],
    ['source differs', () => { document(fixture, 'actions/runs/123').head_sha = '2'.repeat(40); }],
    ['wrong producer', () => { document(fixture, 'actions/runs/123').workflow_id++; }],
    ['fork source', () => { document(fixture, 'actions/runs/123').head_repository.id++; }],
    ['unsupported event', () => { document(fixture, 'actions/runs/123').event = 'push'; }],
    ['job pagination', () => { document(fixture, 'actions/runs/123/attempts/1/jobs?per_page=100').total_count++; }],
    ['wrong job', () => { document(fixture, 'actions/runs/123/attempts/1/jobs?per_page=100').jobs[0].name = 'Skipped J01'; }],
    ['failed job', () => { document(fixture, 'actions/runs/123/attempts/1/jobs?per_page=100').jobs[0].conclusion = 'failure'; }],
    ['stale job attempt', () => { document(fixture, 'actions/runs/123/attempts/1/jobs?per_page=100').jobs[0].run_attempt++; }],
    ['artifact ID', () => { document(fixture, 'actions/artifacts/789').id++; }],
    ['artifact name', () => { document(fixture, 'actions/artifacts/789').name = 'shop-linux-private-123-2'; }],
    ['artifact expired', () => { document(fixture, 'actions/artifacts/789').expired = true; }],
    ['artifact digest absent', () => { delete document(fixture, 'actions/artifacts/789').digest; }],
    ['artifact origin repo', () => { document(fixture, 'actions/artifacts/789').workflow_run.repository_id++; }],
    ['artifact origin source', () => { document(fixture, 'actions/artifacts/789').workflow_run.head_sha = '2'.repeat(40); }],
    ['artifact origin run', () => { document(fixture, 'actions/artifacts/789').workflow_run.id++; }],
    ['artifact before job', () => { document(fixture, 'actions/artifacts/789').created_at = '2026-11-11T00:00:00Z'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    for (const key of Object.keys(fixture.documents)) fixture.documents[key] = structuredClone(baseline[key]); mutate();
    let downloads = 0; await assert.rejects(run(fixture, { api: { ...fixture.api, downloadArtifact() { downloads++; throw Error('must not download'); } } })); assert.equal(downloads, 0);
  });
});

test('raw archive digest, additional pins and bounded writes fail closed', async t => {
  const fixture = await fixtureFor(t);
  await t.test('raw download differs from authenticated digest', async () => { document(fixture, 'actions/artifacts/789').digest = `sha256:${'f'.repeat(64)}`; await assert.rejects(run(fixture), /raw artifact/); });
  fixture.setArchive(fixture.initial.archive);
  await t.test('optional external digest pin differs', async () => { await assert.rejects(run(fixture, { installation: { ...fixture.installation, expected: { archiveSha256: 'f'.repeat(64) } } }), /artifact identity/); });
  await t.test('optional external manifest pin differs', async () => { await assert.rejects(run(fixture, { installation: { ...fixture.installation, expected: { manifestSha256: 'f'.repeat(64) } } }), /portable identity/); });
  await t.test('download byte ceiling', async () => { await assert.rejects(run(fixture, { installation: { ...fixture.installation, limits: { ...fixture.installation.limits, archiveBytes: 100 } } }), /download bound/); });
  await t.test('expansion byte ceiling', async () => { await assert.rejects(run(fixture, { installation: { ...fixture.installation, limits: { ...fixture.installation.limits, expandedBytes: 1024 } } }), /expansion/); });
  await t.test('entry ceiling', async () => { await assert.rejects(run(fixture, { installation: { ...fixture.installation, limits: { ...fixture.installation.limits, files: 2 } } }), /record count/); });
  await t.test('arbitrary URLs and paths rejected', async () => { await assert.rejects(run(fixture, { request: { ...fixture.request, artifactId: 'https://example.invalid/a.zip' } }), /resource ID/); await assert.rejects(run(fixture, { request: { ...fixture.request, url: 'https://example.invalid' } }), /request fields/); });
  await t.test('destination is exclusive', async () => { const destination = join(fixture.root, 'existing'); await mkdir(destination, { mode: 0o700 }); await assert.rejects(run(fixture, { destination }), /EEXIST/); });
  await t.test('recipient symlink and broad permissions rejected', async () => { const link = join(fixture.root, 'key-link'); await symlink(fixture.privateKeyFile, link); await assert.rejects(run(fixture, { privateKeyFile: link }), /recipient key/); await chmod(fixture.privateKeyFile, 0o644); await assert.rejects(run(fixture), /private input/); await chmod(fixture.privateKeyFile, 0o600); });
});

test('original seal requires complete session, context and AES tail authentication', async t => {
  const fixture = await fixtureFor(t);
  const cases = [
    ['ciphertext altered', entries => { entries[0].data[0] ^= 1; }],
    ['ciphertext truncated', entries => { entries[0].data = entries[0].data.subarray(0, -1); }],
    ['ciphertext extra bytes', entries => { entries[0].data = Buffer.concat([entries[0].data, Buffer.from([0])]); }],
    ['AES tag altered', entries => { const item = entries.find(entry => entry.name.endsWith('.enc.json')), data = JSON.parse(item.data); data.tag = Buffer.alloc(16).toString('base64'); item.data = Buffer.from(JSON.stringify(data)); }],
    ['envelope context altered', entries => { const item = entries.find(entry => entry.name.endsWith('.envelope.json')), data = JSON.parse(item.data); data.identity.runId = '999'; item.data = Buffer.from(JSON.stringify(data)); }],
    ['wrapped session altered', entries => { const item = entries.find(entry => entry.name.endsWith('.envelope.json')), data = JSON.parse(item.data); data.wrappedKey = Buffer.alloc(384).toString('base64'); item.data = Buffer.from(JSON.stringify(data)); }],
    ['duplicate envelope JSON key', entries => { const item = entries.find(entry => entry.name.endsWith('.envelope.json')), original = item.data.toString(); assert.equal(original[0], '{'); item.data = Buffer.from('{"algorithm":"RSA-OAEP-SHA256",' + original.slice(1)); }],
    ['unknown seal field', entries => { const item = entries.find(entry => entry.name.endsWith('.enc.json')), data = JSON.parse(item.data); data.extra = true; item.data = Buffer.from(JSON.stringify(data)); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => { const entries = fixture.initial.sealedEntries.map(entry => ({ ...entry, data: Buffer.from(entry.data) })); mutate(entries); fixture.setArchive(fixtureZip(entries)); await assert.rejects(run(fixture)); });
});

test('ZIP entry identities, collision rules and frame boundaries authenticate every byte', async t => {
  const fixture = await fixtureFor(t);
  const cases = [
    ['ZIP traversal', entries => { entries[0].name = '../linux-evidence.tar.gz.enc'; }],
    ['ZIP absolute path', entries => { entries[0].name = '/linux-evidence.tar.gz.enc'; }],
    ['ZIP duplicate', entries => { entries[2].name = entries[1].name; }],
    ['ZIP extra file', entries => { entries.push({ name: 'extra', data: Buffer.from('extra') }); }],
    ['ZIP symlink', entries => { entries[0].mode = 0o120600; }],
    ['ZIP executable mode', entries => { entries[0].mode = 0o100700; }],
    ['ZIP ignored compressed tail with valid CRC and container sizes', entries => { entries[0].compressedTail = Buffer.from([0]); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => { const entries = fixture.initial.sealedEntries.map(entry => ({ ...entry })); mutate(entries); fixture.setArchive(fixtureZip(entries)); await assert.rejects(run(fixture)); });
  for (const [name, mutate] of [
    ['ZIP ignored tail', bytes => Buffer.concat([bytes, Buffer.from([0])])],
    ['ZIP truncated footer', bytes => bytes.subarray(0, -1)],
    ['ZIP local identity differs', bytes => { bytes[30] ^= 1; return bytes; }],
    ['ZIP payload corrupt', bytes => { bytes[30 + bytes.readUInt16LE(26)] ^= 1; return bytes; }],
    ['ZIP prefix bytes', bytes => Buffer.concat([Buffer.from([0]), bytes])],
  ]) await t.test(name, async () => { fixture.setArchive(mutate(Buffer.from(fixture.initial.archive))); await assert.rejects(run(fixture)); });
  await t.test('original ZIP without data descriptors supported', async () => { fixture.setArchive(fixtureZip(fixture.initial.sealedEntries, { descriptor: false })); assert.equal((await run(fixture)).awsImageQualified, false); });
  await t.test('ZIP64 entries, descriptors and complete end records supported', async () => { fixture.setArchive(fixtureZip(fixture.initial.sealedEntries, { zip64: true })); assert.equal((await run(fixture)).awsImageQualified, false); });
  await t.test('ZIP64 declarations without descriptors supported', async () => { fixture.setArchive(fixtureZip(fixture.initial.sealedEntries, { zip64: true, descriptor: false })); assert.equal((await run(fixture)).awsImageQualified, false); });
  await t.test('ZIP descriptors without optional signature supported', async () => { fixture.setArchive(fixtureZip(fixture.initial.sealedEntries, { descriptor: 'unsigned' })); assert.equal((await run(fixture)).awsImageQualified, false); });
  await t.test('ZIP64 descriptors without optional signature supported', async () => { fixture.setArchive(fixtureZip(fixture.initial.sealedEntries, { zip64: true, descriptor: 'unsigned' })); assert.equal((await run(fixture)).awsImageQualified, false); });
});

test('authenticated tar rejects traversal, collisions, links, unsafe modes and incomplete records', async t => {
  const fixture = await fixtureFor(t);
  const cases = [
    ['tar traversal', entries => { entries[1].path = 'shop-linux-private/../outside'; }],
    ['tar absolute path', entries => { entries[1].path = '/outside'; }],
    ['tar duplicate path', entries => { entries.push({ ...entries[1] }); }],
    ['tar filesystem case collision', entries => { entries.push({ ...entries[1], path: entries[1].path.toUpperCase().replace('SHOP-LINUX-PRIVATE', 'shop-linux-private') }); }],
    ['tar symbolic link', entries => { entries[1] = { ...entries[1], type: '2', link: '/outside' }; }],
    ['tar hard link', entries => { entries[1] = { ...entries[1], type: '1', link: '/outside' }; }],
    ['tar special file', entries => { entries[1] = { ...entries[1], type: '6' }; }],
    ['tar extended metadata', entries => { entries[1] = { ...entries[1], type: 'x' }; }],
    ['tar broad directory mode', entries => { entries[0].mode = 0o755; }],
    ['tar broad file mode', entries => { entries.find(entry => entry.data).mode = 0o644; }],
    ['tar setuid mode', entries => { entries.find(entry => entry.data).mode = 0o4600; }],
    ['tar missing parent', entries => { entries[1].path = 'shop-linux-private/missing/child'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => { const entries = copyEntries(fixture.entries); mutate(entries); await fixture.sealEntries(entries); await assert.rejects(run(fixture)); });
  for (const [name, transform] of [
    ['tar missing end markers', bytes => bytes.subarray(0, -1024)],
    ['tar partial final record', bytes => bytes.subarray(0, -1)],
    ['tar bytes after end marker', bytes => Buffer.concat([bytes, Buffer.alloc(512, 1)])],
    ['tar bad checksum', bytes => { bytes[0] ^= 1; return bytes; }],
    ['tar checksum with hidden trailing number', bytes => { bytes[155] = 48; return bytes; }],
    ['tar checksum with non-ASCII octal', bytes => { bytes[148] |= 128; return bytes; }],
  ]) await t.test(name, async () => { await fixture.sealEntries(fixture.entries, { gzip: gzipSync(transform(fixtureTar(fixture.entries))) }); await assert.rejects(run(fixture)); });
});

test('gzip must consume one authenticated complete member and exact checksum trailer', async t => {
  const fixture = await fixtureFor(t);
  for (const [name, transform] of [
    ['extra gzip member', bytes => Buffer.concat([bytes, gzipSync(Buffer.alloc(0))])],
    ['ignored gzip tail', bytes => Buffer.concat([bytes, Buffer.alloc(8)])],
    ['gzip truncated trailer', bytes => bytes.subarray(0, -1)],
    ['gzip wrong CRC', bytes => { bytes[bytes.length - 8] ^= 1; return bytes; }],
    ['gzip wrong output size', bytes => { bytes[bytes.length - 4] ^= 1; return bytes; }],
  ]) await t.test(name, async () => { await fixture.sealEntries(fixture.entries, { gzip: transform(Buffer.from(fixture.initial.compressed)) }); await assert.rejects(run(fixture)); });
});

test('original complete inventory, producer identity, lineage, journey and portable bytes must agree', async t => {
  const fixture = await fixtureFor(t);
  const cases = [
    ['inventory missing file', entries => { const entry = entries.find(item => item.path.endsWith('evidence-inventory.private.json')), value = JSON.parse(entry.data); value.files.pop(); value.filesSha256 = sha256(JSON.stringify(value.files)); entry.data = Buffer.from(JSON.stringify(value)); }],
    ['inventory stale attempt', entries => { const entry = entries.find(item => item.path.endsWith('evidence-inventory.private.json')), value = JSON.parse(entry.data); value.runAttempt = '2'; entry.data = Buffer.from(JSON.stringify(value)); }],
    ['identity stale lineage', entries => { const entry = entries.find(item => item.path.endsWith('portable-release-identity.private.json')), value = JSON.parse(entry.data); value.lineage.runAttempt = '2'; entry.data = Buffer.from(JSON.stringify(value)); updateInventory(entries); }],
    ['incomplete journey', entries => { const entry = entries.find(item => item.path.endsWith('linux-j01.private.json')), value = JSON.parse(entry.data); value.complete = false; entry.data = Buffer.from(JSON.stringify(value)); updateInventory(entries); }],
    ['journey failure', entries => { const entry = entries.find(item => item.path.endsWith('linux-j01.private.json')), value = JSON.parse(entry.data); value.execution.code = 1; entry.data = Buffer.from(JSON.stringify(value)); updateInventory(entries); }],
    ['AWS qualification claim', entries => { const entry = entries.find(item => item.path.endsWith('linux-j01.private.json')), value = JSON.parse(entry.data); value.awsImageQualified = true; entry.data = Buffer.from(JSON.stringify(value)); updateInventory(entries); }],
    ['portable payload differs', entries => { const entry = entries.find(item => item.path.endsWith('payload/native/index.js')); entry.data = Buffer.from('different runtime'); updateInventory(entries); }],
    ['portable mode differs', entries => { const entry = entries.find(item => item.path.endsWith('payload/native/index.js')); entry.mode = 0o700; updateInventory(entries); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => { const entries = copyEntries(fixture.entries); mutate(entries); await fixture.sealEntries(entries); await assert.rejects(run(fixture)); });
});

test('metadata rerun or retained evidence mutation invalidates admission before assembly', async t => {
  const fixture = await fixtureFor(t); let count = 0;
  await assert.rejects(run(fixture, { api: { ...fixture.api, async getJSON(endpoint) { const result = await fixture.api.getJSON(endpoint); if (endpoint.endsWith('/actions/runs/123') && ++count === 2) result.run_attempt++; return result; } } }), /run identity/);
  const result = await run(fixture), native = join(result.portable.root, 'payload/native/index.js');
  const bytes = await readFile(native); await writeFile(native, 'mutated'); await assert.rejects(assertHostedPortableImport(result)); await writeFile(native, bytes);
  const journey = await readFile(result.evidence.journey.path); await writeFile(result.evidence.journey.path, '{}'); await assert.rejects(assertHostedPortableImport(result), /producer evidence/); await writeFile(result.evidence.journey.path, journey);
  result.metadata.run.run_attempt++; await assert.rejects(assertHostedPortableImport(result), /evidence changed/);
});

test('retained ancillary files require private single-link regular descriptors during refresh', async t => {
  const fixture = await fixtureFor(t), result = await run(fixture);
  const target = join(result.portable.root, '../portable-release-identity.private.json');
  await chmod(target, 0o644);
  await assert.rejects(assertHostedPortableImport(result), /file type or mode/);
  await chmod(target, 0o600);
  const duplicate = join(fixture.root, 'identity-hard-link');
  await link(target, duplicate);
  await assert.rejects(assertHostedPortableImport(result), /file type or mode/);
  await unlink(duplicate);
  const original = join(fixture.root, 'original-identity');
  await rename(target, original); await symlink(original, target);
  await assert.rejects(assertHostedPortableImport(result), /file type or mode/);
  await unlink(target); await rename(original, target);
  assert.equal((await assertHostedPortableImport(result)).portable.manifestSha256, result.portable.manifestSha256);
});

test('default GitHub adapter requires protected external configuration before any subprocess', async t => {
  const fixture = await fixtureFor(t);
  await assert.rejects(createGithubArtifactApi(fixture.installation));
  const directory = join(fixture.root, 'gh'); await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o755); await assert.rejects(createGithubArtifactApi({ ...fixture.installation, githubConfigDirectory: directory }), /private directory/);
  await chmod(directory, 0o700); const api = await createGithubArtifactApi({ ...fixture.installation, githubConfigDirectory: directory });
  await assert.rejects(api.getJSON('https://example.invalid/'), /metadata unavailable/);
  await assert.rejects(api.getJSON('/repos/bentbrain/bent-mono/'), /metadata unavailable/);
});

test('default gh adapter uses fixed argv, isolated credentials and bounded private streaming with an offline executable', async t => {
  const fixture = await fixtureFor(t), config = join(fixture.root, 'gh-config'), bin = join(fixture.root, 'bin');
  await mkdir(config, { mode: 0o700 }); await mkdir(bin, { mode: 0o700 });
  await writeFile(join(config, 'documents.private.json'), JSON.stringify(fixture.documents), { mode: 0o600 });
  await writeFile(join(config, 'artifact.private.zip'), fixture.archive, { mode: 0o600 });
  await writeFile(join(bin, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
const directory = process.env.GH_CONFIG_DIR, endpoint = process.argv.at(-1);
fs.appendFileSync(path.join(directory, 'calls.private.jsonl'), JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n', {mode:0o600});
if (endpoint.endsWith('/zip')) process.stdout.write(fs.readFileSync(path.join(directory,'artifact.private.zip')));
else { const docs = JSON.parse(fs.readFileSync(path.join(directory,'documents.private.json'))); if (!Object.hasOwn(docs,endpoint)) process.exit(2); process.stdout.write(JSON.stringify(docs[endpoint])); }\n`, { mode: 0o700 });
  const inherited = Object.fromEntries(['PATH', 'GH_TOKEN', 'GH_HOST', 'AWS_PROFILE'].map(key => [key, process.env[key]]));
  let result, explicit;
  const jobToken = 'ghs_synthetic_explicit_read_only_job_token';
  try {
    process.env.PATH = `${bin}:${process.env.PATH}`; process.env.GH_TOKEN = 'synthetic-token-must-not-reach-child'; process.env.GH_HOST = 'example.invalid'; process.env.AWS_PROFILE = 'synthetic-forbidden-profile';
    result = await run(fixture, { api: undefined, installation: { ...fixture.installation, githubConfigDirectory: config } });
    explicit = await run(fixture, { api: undefined, githubToken: jobToken, installation: { ...fixture.installation, githubConfigDirectory: config } });
  } finally { for (const [name, value] of Object.entries(inherited)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  assert.equal(result.awsImageQualified, false);
  assert.equal(result.evidence.transport, 'authenticated-github-cli'); assert.equal(result.evidence.rawMetadata.length, 10);
  const calls = (await readFile(join(config, 'calls.private.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 22);
  for (const [index, call] of calls.entries()) {
    assert.deepEqual(call.args.slice(0, -1), ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28']);
    assert.ok(call.args.at(-1) === '/repos/bentbrain/bent-mono' || call.args.at(-1).startsWith('/repos/bentbrain/bent-mono/actions/'));
    assert.equal(call.env.GH_CONFIG_DIR, config); assert.equal(call.env.GH_HOST, 'github.com'); assert.equal(call.env.GH_TOKEN, index < 11 ? undefined : jobToken); assert.equal(call.env.AWS_PROFILE, undefined);
  }
  assert.equal((await lstat(result.evidence.archive.path)).mode & 0o777, 0o600);
  assert.equal(explicit.awsImageQualified, false);
  await assert.rejects(createGithubArtifactApi({ ...fixture.installation, githubConfigDirectory: config }, { token: 'token\nwith-newline' }), /bounded GitHub/);
  await assert.rejects(run(fixture, { githubToken: jobToken }), /explicit artifact API/);
});
