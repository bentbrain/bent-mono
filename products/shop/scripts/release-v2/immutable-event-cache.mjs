import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, readRegularFile, sha256 } from './data.mjs';

const checkout = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const hash = value => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Exact immutable event cache identity required');
const maximumEventBytes = 16 * 1024 * 1024;
const owner = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
const fileIdentity = (a, b) => ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => a[key] === b[key]);

async function privateDirectory(path, create = false) {
  check(typeof path === 'string' && resolve(path) === path && path !== checkout && !path.startsWith(`${checkout}${sep}`), 'Private event cache outside source required');
  if (create) await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  check(info.isDirectory() && !info.isSymbolicLink() && owner(info) && (info.mode & 0o777) === 0o700 && await realpath(path) === path,
    'Owned canonical private event cache directory required');
  return info;
}

/** Cached bytes convey content identity. Fresh authenticated heads convey authority. */
export async function createImmutableEventCache({ directory, namespace, maximumEntries = 4096, maximumBytes = 256 * 1024 * 1024 }) {
  hash(namespace);
  check(Number.isSafeInteger(maximumEntries) && maximumEntries > 0 && maximumEntries <= 4096 && Number.isSafeInteger(maximumBytes) &&
    maximumBytes > 0 && maximumBytes <= 256 * 1024 * 1024, 'Bounded immutable event cache capacity required');
  await privateDirectory(directory, true);
  const root = join(directory, namespace); await privateDirectory(root, true);
  const stats = { hits: 0, misses: 0, writes: 0, capacitySkips: 0, busySkips: 0, entries: 0, bytes: 0 };
  async function inventory() {
    await privateDirectory(directory); await privateDirectory(root);
    let entries = 0, bytes = 0;
    for (const name of await readdir(root)) {
      const path = join(root, name), info = await lstat(path);
      if (name === '.write-lock') { await privateDirectory(path); continue; }
      check(/^(?:[a-f0-9]{64}\.json|\.pending-[a-f0-9-]{36})$/.test(name) && info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
        owner(info) && (info.mode & 0o777) === 0o600 && info.size <= maximumEventBytes && await realpath(path) === path, 'Private regular immutable cache member required');
      entries++; bytes += info.size;
    }
    stats.entries = entries; stats.bytes = bytes; return { entries, bytes };
  }
  await inventory();
  const read = async identity => {
    hash(identity); await privateDirectory(directory); await privateDirectory(root);
    const path = join(root, `${identity}.json`);
    let before;
    try { before = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; stats.misses++; return null; }
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && owner(before) && (before.mode & 0o777) === 0o600 &&
      await realpath(path) === path, 'Private regular immutable cache member required');
    const bytes = await readRegularFile(path, maximumEventBytes, true), after = await lstat(path);
    check(fileIdentity(before, after) && sha256(bytes) === identity, 'Immutable event cache content or file identity differs');
    stats.hits++;
    return { bytes, provenance: { kind: 'local-immutable-event-cache', namespace, sha256: identity } };
  };
  const write = async (identity, bytes) => {
    hash(identity); check(Buffer.isBuffer(bytes) && bytes.length <= maximumEventBytes && sha256(bytes) === identity, 'Exact immutable cache content required');
    await privateDirectory(directory); await privateDirectory(root);
    const lock = join(root, '.write-lock'); let acquired;
    try { await mkdir(lock, { mode: 0o700 }); acquired = await privateDirectory(lock); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await privateDirectory(lock); stats.busySkips++; return { stored: false, reason: 'busy' }; }
    const temporary = join(root, `.pending-${randomUUID()}`);
    try {
      const existing = await read(identity);
      if (existing) { check(existing.bytes.equals(bytes), 'Conflicting immutable cache content'); return { stored: true, reason: 'existing' }; }
      const current = await inventory();
      if (current.entries >= maximumEntries || current.bytes + bytes.length > maximumBytes) { stats.capacitySkips++; return { stored: false, reason: 'capacity' }; }
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(root, `${identity}.json`));
      const stored = await read(identity); check(stored && stored.bytes.equals(bytes), 'Immutable cache write readback differs');
      stats.writes++; stats.entries = current.entries + 1; stats.bytes = current.bytes + bytes.length;
      return { stored: true, reason: 'written' };
    } finally {
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const currentLock = await lstat(lock);
      check(currentLock.dev === acquired.dev && currentLock.ino === acquired.ino && currentLock.isDirectory() && !currentLock.isSymbolicLink(), 'Immutable cache write lock identity differs');
      await rmdir(lock);
    }
  };
  return Object.freeze({ read, write, directory: root, measurements: () => ({ ...stats, maximumEntries, maximumBytes }) });
}
