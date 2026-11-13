import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, check, digest, readJSON, sha256, same } from './data.mjs';

const missing = error => error.code === 'ENOENT';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
async function privateDirectory(directory, create = false) {
  check(!`${resolve(directory)}/`.startsWith(repositoryRoot), 'Keep private journals outside the source checkout');
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  check(await realpath(directory) === resolve(directory) && ((await lstat(directory)).mode & 0o077) === 0, 'Private regular journal directory required');
}
async function recoveryAbsent(directory) {
  try { await lstat(resolve(directory, 'recovering.json')); }
  catch (error) { if (missing(error)) return; throw error; }
  throw Error('Explicit writer recovery is active or interrupted');
}
async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableFile(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function failureDetails(error, seen = new Set()) {
  if (!(error instanceof Error)) return { name: 'ThrownValue', message: String(error), stack: null, code: null, cause: null };
  if (seen.has(error)) return { name: error.name, message: error.message, stack: error.stack ?? null, code: null, cause: 'circular' };
  seen.add(error);
  return { name: error.name, message: error.message, stack: error.stack ?? null,
    code: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null,
    cause: error.cause === undefined ? null : failureDetails(error.cause, seen) };
}

// Diagnostics are private append-only evidence. They never advance a release,
// recover a writer or change the head after an admission/provider failure.
export async function recordFailure(directory, error, operation) {
  await privateDirectory(directory, true);
  let observedPhase = null, observedGeneration = null, observationError = null;
  try {
    const head = await readHead(directory);
    observedPhase = head?.state.phase ?? null;
    observedGeneration = head?.head.generation ?? null;
  } catch (failure) { observationError = failureDetails(failure); }
  const record = { schema: 'shop.local-controller-failure/v1', scope: 'inactive-local',
    at: new Date().toISOString(), operation, pid: process.pid, error: failureDetails(error),
    observedPhase, observedGeneration, observedAfterFailure: true, observationError };
  const file = `failure-${randomUUID()}.json`, bytes = canonical(record), path = resolve(directory, file);
  await durableFile(path, bytes);
  await syncDirectory(directory);
  const sha256 = digest(record);
  check(digest(await readJSON(path, Buffer.byteLength(bytes))) === sha256, 'Private failure diagnostic readback differs');
  return { file, sha256 };
}
export async function readHead(directory) {
  let head;
  try { head = await readJSON(resolve(directory, 'head.json')); }
  catch (error) { if (missing(error)) return null; throw error; }
  check(head.schema === 'shop.local-journal-head/v1' && Number.isSafeInteger(head.generation) && head.generation > 0 &&
    /^[a-f0-9]{64}$/.test(head.eventDigest) && Object.keys(head).sort().join(',') === 'eventDigest,generation,schema', 'Malformed journal head');
  const event = await readJSON(resolve(directory, 'events', `${head.eventDigest}.json`), 64 * 1024 * 1024);
  check(digest(event) === head.eventDigest && event.state.generation === head.generation, 'Journal event readback differs');
  check(event.schema === 'shop.local-journal-event/v1' && (event.previous === null || /^[a-f0-9]{64}$/.test(event.previous)), 'Malformed journal event');
  return { head, state: event.state };
}

export async function withWriter(directory, work) {
  await privateDirectory(directory, true);
  await mkdir(resolve(directory, 'events'), { mode: 0o700, recursive: true });
  check((await lstat(resolve(directory, 'events'))).isDirectory() && await realpath(resolve(directory, 'events')) === resolve(directory, 'events'), 'Regular event directory required');
  await recoveryAbsent(directory);
  const lockPath = resolve(directory, 'writer.json');
  const owner = { schema: 'shop.local-writer/v1', pid: process.pid, nonce: randomUUID() };
  try { await durableFile(lockPath, canonical(owner)); await syncDirectory(directory); }
  catch (error) { if (error.code === 'EEXIST') throw Error('Writer is fenced; explicit stopped-process recovery required'); throw error; }
  const assertOwner = async () => check(same(await readJSON(lockPath), owner), 'Writer ownership changed');
  try {
    await recoveryAbsent(directory);
    const initial = await readHead(directory);
    let committed = false;
    const commit = async (state, fault = () => {}) => {
      check(!committed, 'Only one durable transition is permitted per invocation');
      await assertOwner();
      const current = await readHead(directory);
      check(same(current?.head ?? null, initial?.head ?? null), 'Journal CAS conflict');
      state.generation = (initial?.head.generation ?? 0) + 1;
      const event = { schema: 'shop.local-journal-event/v1', previous: initial?.head.eventDigest ?? null, state };
      const eventDigest = digest(event), eventPath = resolve(directory, 'events', `${eventDigest}.json`);
      fault('before-event');
      try { await durableFile(eventPath, canonical(event)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      check(same(await readJSON(eventPath, 64 * 1024 * 1024), event), 'Immutable event readback differs');
      await syncDirectory(resolve(directory, 'events'));
      fault('after-event');
      const next = { schema: 'shop.local-journal-head/v1', generation: state.generation, eventDigest };
      const temporary = resolve(directory, `head-${owner.nonce}.tmp`);
      await durableFile(temporary, canonical(next));
      await assertOwner();
      check(same((await readHead(directory))?.head ?? null, initial?.head ?? null), 'Journal CAS conflict before rename');
      fault('before-head');
      await rename(temporary, resolve(directory, 'head.json'));
      await syncDirectory(directory);
      fault('after-head');
      check(same((await readHead(directory))?.head, next), 'Committed head readback differs');
      committed = true;
      return state;
    };
    return await work({ initial: initial?.state ?? null, commit, assertOwner });
  } finally {
    await assertOwner();
    await unlink(lockPath);
    await syncDirectory(directory);
  }
}

// A dead PID is an explicit local fixture recovery check, never a hosted
// lease/credential fencing mechanism. A live or reused PID stays blocked.
export async function recoverWriter(directory, expectedDigest) {
  await privateDirectory(directory);
  const guard = resolve(directory, 'recovering.json');
  const recovery = { pid: process.pid, nonce: randomUUID() };
  await durableFile(guard, canonical(recovery)); await syncDirectory(directory);
  try {
    const path = resolve(directory, 'writer.json'), bytes = await readFile(path);
    check(sha256(bytes) === expectedDigest, 'Writer recovery compare token differs');
    const owner = await readJSON(path);
    check(owner.schema === 'shop.local-writer/v1' && Number.isSafeInteger(owner.pid) && owner.pid > 0, 'Malformed writer identity');
    let stopped = false;
    try { process.kill(owner.pid, 0); }
    catch (error) { check(error.code === 'ESRCH', 'Cannot establish stopped process'); stopped = true; }
    check(stopped, 'Writer process is still alive; takeover refused');
    check(sha256(await readFile(path)) === expectedDigest, 'Writer changed during recovery');
    await unlink(path); await syncDirectory(directory);
    return { state: 'local-writer-recovered', unresolvedIntent: (await readHead(directory))?.state.operation ?? null };
  } finally {
    check(same(await readJSON(guard), recovery), 'Recovery ownership changed');
    await unlink(guard); await syncDirectory(directory);
  }
}
