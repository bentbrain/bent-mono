import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { canonical, check, sha256 } from './data.mjs';

export async function saveHostedFailure(error, destination) {
  check(typeof destination === 'string' && destination.length > 0, 'Private diagnostic destination required');
  const path = resolve(destination), checkout = await realpath(process.cwd());
  check(path !== checkout && !path.startsWith(`${checkout}${sep}`), 'Private diagnostic directory must be outside source');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  check(entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o077) === 0 && await realpath(path) === path &&
    path !== checkout && !path.startsWith(`${checkout}${sep}`), 'Private diagnostic directory must be outside source');
  const causes = [], seen = new Set(); let current = error;
  while (current && causes.length < 8 && !seen.has(current)) {
    seen.add(current);
    causes.push({ name: String(current.name ?? 'Error').slice(0, 256), message: String(current.message ?? current).slice(0, 16384),
      stack: String(current.stack ?? '').slice(0, 32768), operation: typeof current.operation === 'string' ? current.operation.slice(0, 256) : null,
      status: Number.isInteger(current.status) ? current.status : null });
    current = current.cause;
  }
  const bytes = Buffer.from(canonical({ schema: 'shop.hosted-failure/v1', recordedAt: Date.now(), causes }));
  const file = resolve(path, `failure-${randomUUID()}.private.json`);
  await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  return { path: file, sha256: sha256(bytes) };
}
