import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { openLinuxEvidence } from '../testing/linux-evidence.mjs';
import { check, digest, parseJSON, pathName, readRegularFile, same, sha256 } from './data.mjs';
import { verifyPortableBundle } from './portable-bundle.mjs';

const execute = promisify(execFile);
const repositoryDirectory = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const sealedNames = ['linux-evidence.tar.gz.enc', 'linux-evidence.tar.gz.enc.envelope.json', 'linux-evidence.tar.gz.enc.json'];
const defaultLimits = { archiveBytes: 4 * 1024 ** 3 - 1, expandedBytes: 12 * 1024 ** 3, files: 131072 };
const admissions = new WeakMap();
const githubApis = new WeakSet();
const exact = (value, fields, label) => check(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...fields].sort()), `Unexpected ${label} fields`);
const identifier = value => check(/^[1-9][0-9]{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)), 'Exact GitHub resource ID required');
const hex = value => check(/^[a-f0-9]{64}$/.test(value ?? ''), 'Protected SHA256 pin required');
const outside = (path, root) => path !== root && !path.startsWith(`${root}/`);
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
const crcUpdate = (crc, bytes) => { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return crc >>> 0; };
const uint64 = (bytes, offset) => { const value = bytes.readBigUInt64LE(offset); check(value <= BigInt(Number.MAX_SAFE_INTEGER), 'Archive integer exceeds safe bound'); return Number(value); };

async function readAt(handle, length, position) {
  check(Number.isSafeInteger(length) && length >= 0 && length <= 1024 * 1024, 'Archive record exceeds bound');
  const bytes = Buffer.alloc(length); let read = 0;
  while (read < length) { const next = await handle.read(bytes, read, length - read, position + read); check(next.bytesRead > 0, 'Archive record truncated'); read += next.bytesRead; }
  return bytes;
}

async function privateDirectory(path) {
  check(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'Private path must be absolute and canonical');
  const info = await lstat(path);
  check(info.isDirectory() && (info.mode & 0o777) === 0o700 && (process.getuid === undefined || info.uid === process.getuid()), 'Owned private directory required');
}

function validateInput(request, installation) {
  exact(request, ['runId', 'runAttempt', 'artifactId', 'sourceCommit'], 'artifact request');
  for (const field of ['runId', 'runAttempt', 'artifactId']) identifier(request[field]);
  const { repository, workflow, expected = {} } = installation;
  check(repository?.name === 'bentbrain/bent-mono', 'Pinned Shop repository required');
  identifier(repository.id); identifier(repository.ownerId); identifier(workflow?.id); if (expected.jobId !== undefined) identifier(expected.jobId);
  check(workflow.path === '.github/workflows/shop-linux-journey.yml' && workflow.jobName === 'Built Linux J01' && workflow.jobId === 'journey', 'Original Linux customer journey workflow required');
  check(/^[a-f0-9]{40}$/.test(request.sourceCommit ?? '') && request.sourceCommit !== '0'.repeat(40), 'Exact requested source commit required');
  hex(installation.recipientFingerprint);
  for (const name of ['manifestSha256', 'archiveSha256']) if (expected[name] !== undefined) hex(expected[name]);
  check(Object.keys(expected).every(name => ['manifestSha256', 'archiveSha256', 'lineage', 'jobId'].includes(name)), 'Unexpected optional artifact pin');
  const limits = { ...defaultLimits, ...installation.limits };
  for (const name of Object.keys(defaultLimits)) check(Number.isSafeInteger(limits[name]) && limits[name] > 0 && limits[name] <= defaultLimits[name], 'Artifact limit must tighten the supported bound');
  check(Object.keys(limits).length === Object.keys(defaultLimits).length, 'Unexpected artifact bound');
  return limits;
}

/** Uses only the protected gh configuration and fixed GitHub API resource paths. */
export async function createGithubArtifactApi(installation, { token } = {}) {
  const config = installation.githubConfigDirectory;
  await privateDirectory(config);
  check(outside(config, repositoryDirectory), 'GitHub credentials must remain outside the repository');
  check(token === undefined || typeof token === 'string' && /^[A-Za-z0-9_]{20,1024}$/.test(token), 'Explicit bounded GitHub job token required');
  const env = { PATH: process.env.PATH, GH_CONFIG_DIR: config, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', ...(token === undefined ? {} : { GH_TOKEN: token }) };
  const prefix = `/repos/${installation.repository.name}`;
  const argumentsFor = endpoint => {
    check(typeof endpoint === 'string' && endpoint.startsWith(prefix) && /^\/repos\/bentbrain\/bent-mono(?:\/actions\/(?:runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*\/jobs\?per_page=100)?|artifacts\/[1-9][0-9]*(?:\/zip)?|workflows\/[1-9][0-9]*))?$/.test(endpoint), 'Fixed GitHub artifact endpoint required');
    return ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint];
  };
  const responses = [];
  const api = Object.freeze({
    async getJSON(endpoint) {
      try { const result = await execute('gh', argumentsFor(endpoint), { env, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'buffer' }); const value = parseJSON(result.stdout); responses.push({ endpoint, bytes: Buffer.from(result.stdout) }); return value; }
      catch { throw Error('Authenticated GitHub artifact metadata unavailable'); }
    },
    async downloadArtifact({ endpoint, destination, maxBytes }) {
      const args = argumentsFor(endpoint); check(endpoint.endsWith('/zip'), 'Exact artifact download endpoint required');
      const output = await open(destination, 'wx', 0o600);
      const child = spawn('gh', args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
      const completion = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? accept() : reject(Error('GitHub artifact download failed'))); });
      let bytes = 0;
      const bound = new Transform({ transform(chunk, _, done) { bytes += chunk.length; done(bytes <= maxBytes ? null : Error('Artifact download exceeds bound'), chunk); } });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 120000);
      try { await Promise.all([pipeline(child.stdout, bound, output.createWriteStream()), completion]); check(bytes > 0, 'Empty GitHub artifact download'); }
      catch { child.kill('SIGKILL'); await completion.catch(() => {}); throw Error('Authenticated GitHub artifact download failed'); }
      finally { clearTimeout(deadline); await output.close().catch(() => {}); }
    },
    metadataResponses() { return responses.map(({ endpoint, bytes }) => ({ endpoint, bytes: Buffer.from(bytes) })); },
  });
  githubApis.add(api); return api;
}

async function retainRawMetadata(api, destination) {
  if (!githubApis.has(api)) return [];
  const retained = [], responses = api.metadataResponses();
  check(responses.length <= 10, 'Unexpected GitHub metadata response count');
  for (const [index, response] of responses.entries()) {
    const path = join(destination, `github-response-${index}.private.json`); await writeFile(path, response.bytes, { flag: 'wx', mode: 0o600 });
    retained.push({ endpoint: response.endpoint, path, bytes: response.bytes.length, sha256: sha256(response.bytes) });
  }
  return retained;
}

async function authenticateMetadata(api, request, installation) {
  const prefix = `/repos/${installation.repository.name}`, { repository, workflow, expected = {} } = installation;
  const [repo, definition, run, jobs, artifact] = await Promise.all([
    api.getJSON(prefix), api.getJSON(`${prefix}/actions/workflows/${workflow.id}`), api.getJSON(`${prefix}/actions/runs/${request.runId}`),
    api.getJSON(`${prefix}/actions/runs/${request.runId}/attempts/${request.runAttempt}/jobs?per_page=100`), api.getJSON(`${prefix}/actions/artifacts/${request.artifactId}`),
  ]);
  check(String(repo.id) === String(repository.id) && String(repo.owner?.id) === String(repository.ownerId) && repo.full_name === repository.name && repo.owner?.login === 'bentbrain', 'GitHub repository identity differs');
  check(String(definition.id) === String(workflow.id) && definition.path === workflow.path && definition.state === 'active', 'GitHub workflow identity differs');
  check(String(run.id) === String(request.runId) && String(run.run_attempt) === String(request.runAttempt) && String(run.workflow_id) === String(workflow.id) && run.path === workflow.path &&
    run.status === 'completed' && run.conclusion === 'success' && run.head_sha === request.sourceCommit && ['workflow_dispatch', 'pull_request'].includes(run.event) &&
    String(run.repository?.id) === String(repository.id) && String(run.repository?.owner?.id) === String(repository.ownerId) && run.repository?.full_name === repository.name &&
    String(run.head_repository?.id) === String(repository.id) && run.head_repository?.full_name === repository.name, 'Original successful GitHub run identity differs');
  check(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length === 1, 'Complete original customer journey job required');
  const job = jobs.jobs[0];
  identifier(job.id);
  check((expected.jobId === undefined || String(job.id) === String(expected.jobId)) && String(job.run_id) === String(request.runId) && String(job.run_attempt) === String(request.runAttempt) && job.head_sha === request.sourceCommit &&
    job.name === workflow.jobName && job.status === 'completed' && job.conclusion === 'success', 'Original successful GitHub job differs');
  check(String(artifact.id) === String(request.artifactId) && artifact.name === `shop-linux-private-${request.runId}-${request.runAttempt}` && artifact.expired === false &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') && (expected.archiveSha256 === undefined || artifact.digest === `sha256:${expected.archiveSha256}`) && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 &&
    String(artifact.workflow_run?.id) === String(request.runId) && String(artifact.workflow_run?.repository_id) === String(repository.id) &&
    String(artifact.workflow_run?.head_repository_id) === String(repository.id) && artifact.workflow_run?.head_sha === request.sourceCommit, 'Original retained artifact identity or digest differs');
  const timestamps = [job.started_at, artifact.created_at, artifact.updated_at, job.completed_at, run.updated_at].map(value => Date.parse(value));
  check(timestamps.every(Number.isFinite) && timestamps.every((value, index) => index === 0 || value >= timestamps[index - 1]), 'Artifact attempt timing differs');
  return { repository: repo, workflow: definition, run, jobs, job, artifact };
}

const select = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key] ?? null]));
function metadataIdentity(metadata) {
  const { repository, workflow, run, job, artifact } = metadata;
  return {
    repository: { ...select(repository, ['id', 'full_name']), ownerId: repository.owner.id },
    workflow: select(workflow, ['id', 'path', 'state']),
    run: { ...select(run, ['id', 'run_attempt', 'workflow_id', 'path', 'status', 'conclusion', 'head_sha', 'event', 'head_branch', 'updated_at']),
      pullRequests: (run.pull_requests ?? []).map(pull => ({ number: pull.number, sha: pull.head?.sha ?? null, repositoryId: pull.head?.repo?.id ?? null })) },
    job: select(job, ['id', 'run_id', 'run_attempt', 'head_sha', 'name', 'status', 'conclusion', 'started_at', 'completed_at', 'steps']),
    artifact: select(artifact, ['id', 'name', 'digest', 'size_in_bytes', 'expired', 'created_at', 'updated_at', 'workflow_run']),
  };
}

function authenticatedLineage(metadata, request, installation, producerWorkflowRef) {
  const { run } = metadata; let ref;
  if (run.event === 'workflow_dispatch') {
    check(typeof run.head_branch === 'string' && /^[A-Za-z0-9_./-]+$/.test(run.head_branch) && !run.head_branch.includes('..'), 'Original workflow branch required');
    ref = `refs/heads/${run.head_branch}`;
  } else {
    const prefix = `${installation.repository.name}/${installation.workflow.path}@`, matched = typeof producerWorkflowRef === 'string' && producerWorkflowRef.startsWith(prefix) && /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(producerWorkflowRef.slice(prefix.length));
    check(matched && Array.isArray(run.pull_requests) && run.pull_requests.length <= 1, 'Authenticated original pull request workflow ref required');
    identifier(matched[1]); ref = `refs/pull/${matched[1]}/merge`;
    // GitHub can clear this association after a pull request merges. The exact
    // original artifact digest still authenticates the producer's workflow ref.
    if (run.pull_requests.length) {
      const pull = run.pull_requests[0]; identifier(pull.number);
      check(String(pull.number) === matched[1] && pull.head?.sha === request.sourceCommit && String(pull.head?.repo?.id) === String(installation.repository.id), 'Original pull request source differs');
    }
  }
  const lineage = { kind: 'github-actions', repository: installation.repository.name, sourceCommit: request.sourceCommit,
    runId: String(request.runId), runAttempt: String(request.runAttempt), workflowRef: `${installation.repository.name}/${installation.workflow.path}@${ref}`, jobId: installation.workflow.jobId };
  check(producerWorkflowRef === lineage.workflowRef, 'Authenticated producer workflow ref differs');
  check(installation.expected?.lineage === undefined || same(installation.expected.lineage, lineage), 'Additional protected lineage pin differs');
  return lineage;
}

async function hashFile(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); check(before.isFile() && before.size > 0 && before.size <= maximum && (before.mode & 0o777) === 0o600 && before.nlink === 1, 'Bounded private archive required');
    const hash = createHash('sha256'); let length = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) { length += bytes.length; check(length <= maximum, 'Archive exceeds bound'); hash.update(bytes); }
    const after = await handle.stat(), current = await lstat(path);
    check(['dev', 'ino', 'mode', 'size', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key] && after[key] === current[key]) && length === before.size, 'Archive changed during authentication');
    return { sha256: hash.digest('hex'), bytes: length, fileIdentity: Object.fromEntries(['dev', 'ino', 'mode', 'size', 'nlink', 'mtimeMs', 'ctimeMs'].map(key => [key, String(before[key])])) };
  } finally { await handle.close(); }
}

async function verifyRetainedEvidence(root, expected, wantedDirectories, prefix = '', actual = [], directories = []) {
  const entries = (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const names = entries.map(entry => entry.name);
  for (const entry of entries) {
    const name = entry.name;
    const path = prefix ? `${prefix}/${name}` : name; pathName(path);
    const target = join(root, path);
    if (entry.isDirectory()) { const info = await lstat(target); check(info.isDirectory() && (info.mode & 0o777) === 0o700, 'Retained evidence directory mode changed'); directories.push(path); await verifyRetainedEvidence(root, expected, wantedDirectories, path, actual, directories); }
    else {
      check(entry.isFile(), 'Retained evidence file type or mode changed');
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), hash = createHash('sha256'); let size = 0;
      let info;
      try {
        info = await handle.stat();
        check(info.isFile() && info.nlink === 1 && [0o600, 0o700].includes(info.mode & 0o777), 'Retained evidence file type or mode changed');
        for await (const bytes of handle.createReadStream({ autoClose: false })) { size += bytes.length; check(size <= info.size, 'Retained evidence length changed'); hash.update(bytes); }
        check(size === info.size && sameFile(info, await handle.stat()) && sameFile(info, await lstat(target)), 'Retained evidence changed during refresh');
      }
      finally { await handle.close(); }
      actual.push({ path, bytes: size, sha256: hash.digest('hex'), executable: Boolean(info.mode & 0o111) });
    }
  }
  check(same(names, (await readdir(join(root, prefix))).sort()), 'Retained evidence paths changed');
  if (!prefix) {
    check(same(actual.sort((a, b) => a.path < b.path ? -1 : 1), expected), 'Original retained evidence inventory changed');
    check(same(wantedDirectories, directories.sort()), 'Retained evidence directory inventory changed');
  }
}
const sameFile = (before, after) => ['dev', 'ino', 'mode', 'size', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]);

function zipExtra(bytes, values) {
  let cursor = 0; const seen = new Set();
  while (cursor < bytes.length) {
    check(cursor + 4 <= bytes.length, 'ZIP extra field truncated'); const type = bytes.readUInt16LE(cursor), length = bytes.readUInt16LE(cursor + 2); cursor += 4;
    check(cursor + length <= bytes.length && !seen.has(type), 'ZIP extra field differs'); seen.add(type);
    if (type === 1) {
      let at = cursor;
      for (const key of ['size', 'compressed', 'offset']) if (values[key] === 0xffffffff) { check(at + 8 <= cursor + length, 'ZIP64 field truncated'); values[key] = uint64(bytes, at); at += 8; }
      check(at === cursor + length, 'Unexpected ZIP64 field');
    }
    cursor += length;
  }
  return values;
}

async function extractSeal(zip, destination, limits) {
  await mkdir(destination, { mode: 0o700 });
  const handle = await open(zip, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(), tail = await readAt(handle, Math.min(info.size, 65557), Math.max(0, info.size - 65557));
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { check(end === -1, 'Ambiguous ZIP trailer'); end = at; }
    check(end >= 0, 'ZIP end record missing'); const eocd = tail.subarray(end);
    check(eocd.readUInt16LE(4) === 0 && eocd.readUInt16LE(6) === 0 && eocd.readUInt16LE(20) === 0, 'Exact single-disk original artifact ZIP required');
    let centralBytes = eocd.readUInt32LE(12), centralOffset = eocd.readUInt32LE(16), endOffset = info.size - tail.length + end;
    const zip64 = eocd.readUInt16LE(8) === 0xffff || eocd.readUInt16LE(10) === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff ||
      endOffset >= 20 && (await readAt(handle, 4, endOffset - 20)).readUInt32LE(0) === 0x07064b50;
    if (zip64) {
      check(endOffset >= 76, 'ZIP64 end records truncated');
      const locator = await readAt(handle, 20, endOffset - 20);
      check(locator.readUInt32LE(0) === 0x07064b50 && locator.readUInt32LE(4) === 0 && locator.readUInt32LE(16) === 1, 'Single-disk ZIP64 locator required');
      const position = uint64(locator, 8), record = await readAt(handle, 56, position);
      check(record.readUInt32LE(0) === 0x06064b50 && uint64(record, 4) === 44 && record.readUInt32LE(16) === 0 && record.readUInt32LE(20) === 0 &&
        uint64(record, 24) === 3 && uint64(record, 32) === 3 && position + 56 === endOffset - 20, 'Exact ZIP64 end record required');
      for (const offset of [8, 10]) check([3, 0xffff].includes(eocd.readUInt16LE(offset)), 'ZIP64 entry count differs');
      const bytes = uint64(record, 40), offset = uint64(record, 48);
      check([bytes, 0xffffffff].includes(centralBytes) && [offset, 0xffffffff].includes(centralOffset), 'ZIP64 central directory declarations differ');
      centralBytes = bytes; centralOffset = offset; endOffset = position;
    } else check(eocd.readUInt16LE(8) === 3 && eocd.readUInt16LE(10) === 3, 'Complete original artifact ZIP required');
    check(centralBytes <= 16384 && centralOffset + centralBytes === endOffset, 'ZIP central directory framing differs');
    const central = await readAt(handle, centralBytes, centralOffset), entries = []; let cursor = 0;
    while (cursor < central.length) {
      check(cursor + 46 <= central.length && central.readUInt32LE(cursor) === 0x02014b50, 'ZIP central entry truncated');
      const nameLength = central.readUInt16LE(cursor + 28), extraLength = central.readUInt16LE(cursor + 30), commentLength = central.readUInt16LE(cursor + 32), endEntry = cursor + 46 + nameLength + extraLength + commentLength;
      check(endEntry <= central.length && commentLength === 0 && central.readUInt16LE(cursor + 34) === 0, 'ZIP central record differs');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
      check(sealedNames.includes(name) && !entries.some(entry => entry.name === name), 'Original sealed files required without ZIP duplicates');
      const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10), attributes = central.readUInt32LE(cursor + 38), mode = attributes >>> 16;
      check((flags & ~0x808) === 0 && [0, 8].includes(method) && (attributes & 0x10) === 0 && (mode === 0 || ((mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000) && [0o600, 0o644].includes(mode & 0o7777)), 'ZIP type, mode or compression differs');
      const entry = zipExtra(central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength), { name, flags, method, crc: central.readUInt32LE(cursor + 16), size: central.readUInt32LE(cursor + 24), compressed: central.readUInt32LE(cursor + 20), offset: central.readUInt32LE(cursor + 42), zip64: central.readUInt32LE(cursor + 24) === 0xffffffff || central.readUInt32LE(cursor + 20) === 0xffffffff });
      check(entry.size > 0 && entry.size <= (name.endsWith('.json') ? 16384 : limits.archiveBytes), 'ZIP entry exceeds bound'); entries.push(entry); cursor = endEntry;
    }
    check(entries.length === 3, 'Complete sealed artifact required'); let offset = 0;
    const ordered = [...entries].sort((a, b) => a.offset - b.offset);
    for (const [index, entry] of ordered.entries()) {
      check(entry.offset === offset, 'ZIP overlap, prefix or ignored record');
      const header = await readAt(handle, 30, offset); check(header.readUInt32LE(0) === 0x04034b50, 'ZIP local entry missing');
      const nameLength = header.readUInt16LE(26), extraLength = header.readUInt16LE(28), local = await readAt(handle, nameLength + extraLength, offset + 30);
      check(header.readUInt16LE(6) === entry.flags && header.readUInt16LE(8) === entry.method && local.subarray(0, nameLength).equals(Buffer.from(entry.name)), 'ZIP local and central identity differ');
      const declared = zipExtra(local.subarray(nameLength), { size: header.readUInt32LE(22), compressed: header.readUInt32LE(18) });
      check(entry.flags & 8 ? [0, entry.crc].includes(header.readUInt32LE(14)) && [0, entry.size].includes(declared.size) && [0, entry.compressed].includes(declared.compressed)
        : header.readUInt32LE(14) === entry.crc && declared.size === entry.size && declared.compressed === entry.compressed, 'ZIP local sizes or CRC differ');
      const start = offset + 30 + nameLength + extraLength, end = start + entry.compressed;
      check(entry.compressed > 0 && end <= centralOffset && (entry.method !== 0 || entry.compressed === entry.size), 'ZIP payload framing differs');
      const input = handle.createReadStream({ start, end: end - 1, autoClose: false }), output = await open(join(destination, entry.name), 'wx', 0o600);
      let size = 0, crc = 0xffffffff; const counter = new Transform({ transform(bytes, _, done) { size += bytes.length; crc = crcUpdate(crc, bytes); done(size <= entry.size ? null : Error('ZIP expansion exceeds declared bound'), bytes); } });
      const inflater = entry.method === 8 ? createInflateRaw() : null;
      try { await pipeline(...[input, inflater, counter, output.createWriteStream()].filter(Boolean)); }
      finally { await output.close().catch(() => {}); }
      check(size === entry.size && (crc ^ 0xffffffff) >>> 0 === entry.crc && (!inflater || inflater.bytesWritten === entry.compressed), 'ZIP CRC, length or compressed tail differs');
      offset = end;
      if (entry.flags & 8) {
        const wide = entry.zip64 || header.readUInt32LE(22) === 0xffffffff || header.readUInt32LE(18) === 0xffffffff;
        const length = (ordered[index + 1]?.offset ?? centralOffset) - offset, bare = wide ? 20 : 12;
        check(length === bare || length === bare + 4, 'ZIP descriptor frame length differs');
        const signature = length === bare + 4, descriptor = await readAt(handle, length, offset), at = signature ? 4 : 0;
        check((!signature || descriptor.readUInt32LE(0) === 0x08074b50) && descriptor.readUInt32LE(at) === entry.crc && (wide ? uint64(descriptor, at + 4) : descriptor.readUInt32LE(at + 4)) === entry.compressed &&
          (wide ? uint64(descriptor, at + 12) : descriptor.readUInt32LE(at + 8)) === entry.size, 'ZIP descriptor differs'); offset += descriptor.length;
      }
    }
    check(offset === centralOffset, 'ZIP ignored tail or extra local entry');
  } finally { await handle.close(); }
}

function tarString(bytes) {
  const nul = bytes.indexOf(0), text = bytes.subarray(0, nul === -1 ? bytes.length : nul);
  check(nul === -1 || bytes.subarray(nul).every(byte => byte === 0), 'Tar string padding differs');
  return new TextDecoder('utf-8', { fatal: true }).decode(text);
}
function tarNumber(bytes) {
  check(bytes.every(byte => byte === 0 || byte === 32 || byte >= 48 && byte <= 55), 'Canonical tar octal required');
  const matched = /^ *([0-7]+)[\0 ]*$/.exec(bytes.toString('ascii')); check(matched, 'Canonical tar octal padding required');
  const value = parseInt(matched[1], 8); check(Number.isSafeInteger(value), 'Tar integer exceeds bound'); return value;
}

async function extractTarGzip(source, destination, limits) {
  await mkdir(destination, { mode: 0o700 });
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const files = [], directories = new Set(), paths = new Set(); let output, pending = Buffer.alloc(0), current, remaining = 0, padding = 0, longName, zeros = 0, total = 0, crc = 0xffffffff;
  try {
    const size = (await handle.stat()).size, header = await readAt(handle, 10, 0);
    check(header[0] === 31 && header[1] === 139 && header[2] === 8 && (header[3] & ~31) === 0, 'Gzip header differs');
    let start = 10; const flags = header[3];
    if (flags & 4) { const length = (await readAt(handle, 2, start)).readUInt16LE(0); start += 2 + length; }
    for (const bit of [8, 16]) if (flags & bit) { let byte; do { check(start < Math.min(size - 8, 65536), 'Gzip header exceeds bound'); byte = (await readAt(handle, 1, start++))[0]; } while (byte !== 0); }
    if (flags & 2) { const expected = (await readAt(handle, 2, start)).readUInt16LE(0); check(((crcUpdate(0xffffffff, await readAt(handle, start, 0)) ^ 0xffffffff) & 65535) === expected, 'Gzip header CRC differs'); start += 2; }
    check(start <= 65536 && start < size - 8, 'Gzip header truncated');
    const inflater = createInflateRaw(), input = handle.createReadStream({ start, end: size - 1, autoClose: false });
    const pumping = pipeline(input, inflater); pumping.catch(() => {});
    for await (const chunk of inflater) {
      total += chunk.length; check(total <= limits.expandedBytes, 'Tar expansion exceeds protected bound'); crc = crcUpdate(crc, chunk);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (remaining) {
          const count = Math.min(remaining, pending.length), bytes = pending.subarray(0, count);
          if (current.kind === 'long') current.parts.push(Buffer.from(bytes));
          else { let written = 0; while (written < bytes.length) { const part = await output.write(bytes, written, bytes.length - written); check(part.bytesWritten > 0, 'Tar file write incomplete'); written += part.bytesWritten; } current.hash.update(bytes); }
          remaining -= count; pending = pending.subarray(count);
          if (!remaining) {
            if (current.kind === 'long') { const bytes = Buffer.concat(current.parts); check(bytes.at(-1) === 0, 'GNU tar long name terminator required'); longName = tarString(bytes); }
            else { await output.close(); output = undefined; files.push({ path: current.path, bytes: current.size, sha256: current.hash.digest('hex'), executable: current.executable }); }
          }
          continue;
        }
        if (padding) { const count = Math.min(padding, pending.length); check(pending.subarray(0, count).every(byte => byte === 0), 'Tar data padding differs'); padding -= count; pending = pending.subarray(count); continue; }
        if (pending.length < 512) break;
        const record = pending.subarray(0, 512); pending = pending.subarray(512);
        if (record.every(byte => byte === 0)) { zeros++; continue; }
        check(zeros === 0, 'Tar nonzero record after end marker');
        const expected = tarNumber(record.subarray(148, 156)); let sum = 0; for (let at = 0; at < 512; at++) sum += at >= 148 && at < 156 ? 32 : record[at]; check(sum === expected, 'Tar header checksum differs');
        const type = record[156], length = tarNumber(record.subarray(124, 136)), mode = tarNumber(record.subarray(100, 108));
        check(tarString(record.subarray(157, 257)) === '' && ['ustar', 'ustar '].includes(tarString(record.subarray(257, 263))), 'Ordinary GNU/ustar record required');
        let path = tarString(record.subarray(0, 100));
        if (record.subarray(257, 263).equals(Buffer.from('ustar\0'))) { const prefix = tarString(record.subarray(345, 500)); if (prefix) path = `${prefix}/${path}`; }
        if (type === 76) {
          check(!longName && length > 0 && length <= 4096 && path === '././@LongLink', 'Bounded GNU long name required'); current = { kind: 'long', parts: [] }; remaining = length; padding = (512 - length % 512) % 512; continue;
        }
        check(type === 0 || type === 48 || type === 53, 'Tar links, extended metadata and special files are forbidden');
        path = longName ?? path; longName = undefined;
        if (type === 53 && path.endsWith('/')) path = path.slice(0, -1);
        check(path === 'shop-linux-private' || path.startsWith('shop-linux-private/'), 'Tar path escapes original evidence root');
        pathName(path === 'shop-linux-private' ? path : path.slice('shop-linux-private/'.length));
        const collision = path.normalize('NFC').toLowerCase(); check(!paths.has(collision), 'Tar duplicate or filesystem path collision'); paths.add(collision);
        check(paths.size <= limits.files, 'Tar record count exceeds bound');
        const parent = dirname(path); check(parent === '.' || directories.has(parent), 'Tar parent directory must precede its children');
        if (type === 53) { check(length === 0 && mode === 0o700, 'Private tar directory mode differs'); await mkdir(join(destination, path), { mode: 0o700 }); directories.add(path); }
        else {
          check([0o600, 0o700].includes(mode) && length <= 512 * 1024 ** 2, 'Private tar file mode or size differs');
          current = { path: path.slice('shop-linux-private/'.length), size: length, executable: mode === 0o700, hash: createHash('sha256') }; check(path !== 'shop-linux-private', 'Tar evidence root must be a directory');
          output = await open(join(destination, path), 'wx', mode); remaining = length; padding = (512 - length % 512) % 512;
          if (!length) { await output.close(); output = undefined; files.push({ path: current.path, bytes: 0, sha256: current.hash.digest('hex'), executable: current.executable }); }
        }
      }
    }
    await pumping;
    check(!remaining && !padding && !longName && pending.length === 0 && zeros >= 2, 'Tar frame truncated or end marker missing');
    const trailerOffset = start + inflater.bytesWritten; check(trailerOffset + 8 === size, 'Gzip extra member or ignored trailing bytes');
    const trailer = await readAt(handle, 8, trailerOffset);
    check(trailer.readUInt32LE(0) === (crc ^ 0xffffffff) >>> 0 && trailer.readUInt32LE(4) === total % 2 ** 32, 'Gzip CRC or length differs');
    return { files: files.sort((a, b) => a.path < b.path ? -1 : 1), directories: [...directories].filter(path => path !== 'shop-linux-private').map(path => path.slice('shop-linux-private/'.length)).sort() };
  } finally { await output?.close().catch(() => {}); await handle.close(); }
}

/** Authenticate and retain one original Actions artifact. Assembly uses a separate directory. */
export async function importHostedPortable({ request, installation, destination, api, privateKeyFile, githubToken }) {
  request = structuredClone(request); installation = structuredClone(installation);
  const limits = validateInput(request, installation);
  check(isAbsolute(destination) && resolve(destination) === destination && outside(destination, repositoryDirectory), 'New private artifact destination outside checkout required');
  await privateDirectory(dirname(destination));
  check(isAbsolute(privateKeyFile) && await realpath(privateKeyFile) === privateKeyFile && outside(privateKeyFile, repositoryDirectory) && outside(privateKeyFile, destination), 'Protected recipient key must remain outside checkout and inbound artifact');
  check(api === undefined || githubToken === undefined, 'Select an explicit artifact API or GitHub job token');
  api ??= await createGithubArtifactApi(installation, { token: githubToken });
  check(typeof api.getJSON === 'function' && typeof api.downloadArtifact === 'function', 'Explicit artifact API required');
  const metadata = await authenticateMetadata(api, request, installation);
  check(metadata.artifact.size_in_bytes <= limits.archiveBytes, 'Retained artifact exceeds protected download bound');
  await mkdir(destination, { mode: 0o700 });
  const archive = join(destination, 'original-actions-artifact.zip');
  let privateKeyPem;
  try {
    const metadataFile = join(destination, 'github-metadata.private.json'); await writeFile(metadataFile, JSON.stringify(metadata) + '\n', { flag: 'wx', mode: 0o600 });
    privateKeyPem = await readRegularFile(privateKeyFile, 16384, true);
    await api.downloadArtifact({ endpoint: `/repos/${installation.repository.name}/actions/artifacts/${request.artifactId}/zip`, destination: archive, maxBytes: limits.archiveBytes });
    const archiveIdentity = await hashFile(archive, limits.archiveBytes);
    check(`sha256:${archiveIdentity.sha256}` === metadata.artifact.digest && archiveIdentity.bytes === metadata.artifact.size_in_bytes, 'Downloaded raw artifact SHA256 or size differs');
    const seal = join(destination, 'original-seal'); await extractSeal(archive, seal, limits);
    const encrypted = join(seal, 'linux-evidence.tar.gz.enc'), plaintext = join(destination, 'authenticated-linux-evidence.tar.gz');
    // Reject lossy JSON inputs before the existing envelope/decryption helpers parse them.
    for (const name of sealedNames.filter(name => name.endsWith('.json'))) parseJSON(await readRegularFile(join(seal, name), 16384));
    await openLinuxEvidence(encrypted, plaintext, { sourceCommit: request.sourceCommit, runId: String(request.runId), filename: 'linux-evidence.json' }, { privateKeyPem, keyFingerprint: installation.recipientFingerprint });
    const retainedTransport = await Promise.all([...sealedNames.map(name => join(seal, name)), plaintext].map(async path => ({ path, ...await hashFile(path, limits.archiveBytes) })));
    const evidenceDirectory = join(destination, 'evidence'), { files, directories } = await extractTarGzip(plaintext, evidenceDirectory, limits), original = join(evidenceDirectory, 'shop-linux-private');
    const inventoryPath = join(original, 'evidence-inventory.private.json'), inventoryBytes = await readRegularFile(inventoryPath, 32 * 1024 ** 2, true), inventory = parseJSON(inventoryBytes, 32 * 1024 ** 2);
    exact(inventory, ['schema', 'sourceCommit', 'runId', 'runAttempt', 'workflowRef', 'repository', 'recipe', 'files', 'filesSha256'], 'Linux evidence inventory');
    const lineage = authenticatedLineage(metadata, request, installation, inventory.workflowRef);
    const actual = files.filter(file => file.path !== 'evidence-inventory.private.json');
    check(inventory.schema === 'shop.hosted-linux-evidence/v1' && inventory.sourceCommit === request.sourceCommit && inventory.runId === String(request.runId) && inventory.runAttempt === String(request.runAttempt) &&
      inventory.workflowRef === lineage.workflowRef && inventory.repository === installation.repository.name && Array.isArray(inventory.files) &&
      same(actual, [...inventory.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) && sha256(JSON.stringify(inventory.files)) === inventory.filesSha256, 'Authenticated complete Linux evidence inventory differs');
    const expectedIdentity = parseJSON(await readRegularFile(join(original, 'portable-release-identity.private.json'), 65536, true));
    exact(expectedIdentity, ['manifestSha256', 'originSourceCommit', 'lineage', 'requireHostedLineage'], 'original portable identity');
    hex(expectedIdentity.manifestSha256);
    check(same(expectedIdentity, { manifestSha256: expectedIdentity.manifestSha256, originSourceCommit: request.sourceCommit, lineage, requireHostedLineage: true }) &&
      (installation.expected?.manifestSha256 === undefined || installation.expected.manifestSha256 === expectedIdentity.manifestSha256), 'Original portable identity differs from authenticated admission');
    const portable = await verifyPortableBundle(join(original, 'portable-release'), expectedIdentity);
    const journeyPath = join(original, 'journey/linux-j01.private.json'), journeyBytes = await readRegularFile(journeyPath, 16 * 1024 ** 2, true), journey = parseJSON(journeyBytes, 16 * 1024 ** 2);
    check(journey.schema === 'shop.linux-j01/v1' && journey.qualification === 'linux-candidate-execution' && journey.complete === true && journey.dirtySnapshot === false && journey.awsImageQualified === false && journey.productionQualified === false &&
      journey.sourceCommit === request.sourceCommit && journey.portableManifestSha256 === expectedIdentity.manifestSha256 && same(journey.execution, { code: 0, signal: null, overflow: false }) && !Object.hasOwn(journey, 'failure'), 'Completed retained Linux customer journey required');
    const recheck = await authenticateMetadata(api, request, installation);
    check(same(metadataIdentity(recheck), metadataIdentity(metadata)) && same(authenticatedLineage(recheck, request, installation, inventory.workflowRef), lineage), 'GitHub run or artifact changed during intake');
    const recheckFile = join(destination, 'github-metadata-recheck.private.json'); await writeFile(recheckFile, JSON.stringify(recheck) + '\n', { flag: 'wx', mode: 0o600 });
    const rawMetadata = await retainRawMetadata(api, destination);
    check(same(await hashFile(archive, limits.archiveBytes), archiveIdentity), 'Original GitHub archive changed during intake');
    const evidence = { schema: 'shop.hosted-artifact-intake/v1', request: { ...request }, archive: { path: archive, ...archiveIdentity }, inventory: { path: inventoryPath, sha256: sha256(inventoryBytes) },
      journey: { path: journeyPath, sha256: sha256(journeyBytes) }, metadata: { path: metadataFile, sha256: digest(metadata) }, metadataRecheck: { path: recheckFile, sha256: digest(recheck) }, rawMetadata,
      transport: githubApis.has(api) ? 'authenticated-github-cli' : 'explicit-artifact-api', retainedTransport, manifestSha256: portable.manifestSha256, originSourceCommit: request.sourceCommit, lineage, awsImageQualified: false };
    const evidenceFile = join(destination, 'intake.private.json'); await writeFile(evidenceFile, JSON.stringify(evidence) + '\n', { flag: 'wx', mode: 0o600 });
    const result = Object.freeze({ portable, metadata, evidence: { ...evidence, path: evidenceFile }, awsImageQualified: false });
    admissions.set(result, { archive, archiveIdentity, maximum: limits.archiveBytes, evidenceFile, evidenceDigest: digest(evidence), metadataFile, metadataDigest: digest(metadata), root: portable.root, expected: structuredClone(portable.expected), original, files: structuredClone(files), directories, installationDigest: digest(installation), sourceCommit: request.sourceCommit });
    return result;
  } catch (error) {
    await retainRawMetadata(api, destination).catch(() => {});
    await writeFile(join(destination, 'intake-failed.private.json'), JSON.stringify({ schema: 'shop.hosted-artifact-intake-failed/v1', message: error.message }) + '\n', { flag: 'wx', mode: 0o600 }).catch(() => {});
    throw error;
  } finally { privateKeyPem?.fill(0); }
}

/** Refresh retained bytes and reject caller-created admission descriptors. */
export async function assertHostedPortableImport(result, { installation, sourceCommit } = {}) {
  const admitted = admissions.get(result); check(admitted, 'Authenticated in-process artifact intake required');
  check((installation === undefined || digest(installation) === admitted.installationDigest) && (sourceCommit === undefined || sourceCommit === admitted.sourceCommit), 'Artifact intake protected installation or source differs');
  check(same(await hashFile(admitted.archive, admitted.maximum), admitted.archiveIdentity), 'Retained original artifact changed');
  const evidence = parseJSON(await readRegularFile(admitted.evidenceFile, 1024 * 1024, true));
  const metadata = parseJSON(await readRegularFile(admitted.metadataFile, 1024 * 1024, true));
  const { path: evidencePath, ...resultEvidence } = result.evidence;
  check(digest(evidence) === admitted.evidenceDigest && digest(metadata) === admitted.metadataDigest && digest(result.metadata) === admitted.metadataDigest &&
    evidencePath === admitted.evidenceFile && same(resultEvidence, evidence), 'Retained artifact admission evidence changed');
  for (const ref of [evidence.inventory, evidence.journey]) check(sha256(await readRegularFile(ref.path, 32 * 1024 ** 2, true)) === ref.sha256, 'Retained producer evidence changed');
  check(digest(parseJSON(await readRegularFile(evidence.metadataRecheck.path, 1024 * 1024, true))) === evidence.metadataRecheck.sha256, 'Retained metadata recheck changed');
  for (const ref of evidence.rawMetadata) { const bytes = await readRegularFile(ref.path, 1024 * 1024, true); check(bytes.length === ref.bytes && sha256(bytes) === ref.sha256, 'Retained raw GitHub response changed'); }
  for (const { path, ...identity } of evidence.retainedTransport) check(same(await hashFile(path, admitted.maximum), identity), 'Retained encrypted or authenticated archive changed');
  const portable = await verifyPortableBundle(admitted.root, admitted.expected);
  await verifyRetainedEvidence(admitted.original, admitted.files, admitted.directories);
  check(result.portable.root === admitted.root && result.portable.manifestSha256 === portable.manifestSha256 && same(result.portable.expected, admitted.expected), 'Retained portable admission changed');
  return { portable, metadata, evidence: { ...evidence, path: admitted.evidenceFile }, awsImageQualified: false };
}
