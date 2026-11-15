import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, filesUnder, readRegularFile, same, sha256 } from './data.mjs';

const checkout = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

// A session never consumes an artifact path supplied by its caller after this
// copy. Admission authenticates the copied bytes, and subsequent reference reads
// still check their full content digests. No stat tuple grants admission.
export async function snapshotRelease(options) {
  check(typeof options.evidenceDirectory === 'string', 'Explicit private session evidence directory required');
  const parent = resolve(options.evidenceDirectory);
  check(parent !== checkout && !parent.startsWith(`${checkout}${sep}`), 'Private release snapshot must be outside source');
  for (const path of [options.bundle, options.portable]) {
    const base = await realpath(path);
    check(parent !== base && !parent.startsWith(`${base}${sep}`), 'Session evidence must be separate from imported release bytes');
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const entry = await lstat(parent);
  check(entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o777) === 0o700 && await realpath(parent) === parent &&
    (typeof process.getuid !== 'function' || entry.uid === process.getuid()), 'Owned private session evidence directory required');
  const root = await mkdtemp(join(parent, 'verified-session-')), directories = [root], records = [];
  let copiedBytes = 0;
  const started = process.hrtime.bigint();
  const directory = async path => {
    if (directories.includes(path)) return;
    if (path !== root) await directory(dirname(path));
    await mkdir(path, { recursive: true, mode: 0o700 }); directories.push(path);
  };
  const copy = async (source, target, maximumBytes = 512 * 1024 * 1024) => {
    const bytes = await readRegularFile(source, maximumBytes);
    check(records.length < 65536 && copiedBytes + bytes.length <= 8 * 1024 ** 3, 'Release snapshot exceeds byte or file bound');
    const entry = await lstat(source);
    await directory(dirname(target)); await writeFile(target, bytes, { flag: 'wx', mode: entry.mode & 0o111 ? 0o700 : 0o600 });
    copiedBytes += bytes.length; records.push({ path: relative(root, target), bytes: bytes.length, sha256: sha256(bytes) });
  };
  const tree = async (source, name) => {
    const original = await realpath(source), destination = join(root, name), paths = await filesUnder(original);
    await directory(destination);
    for (const path of paths) await copy(join(original, path), join(destination, path));
    check(same(paths, await filesUnder(original)), 'Release inventory changed while taking private snapshot');
    return { original, destination };
  };
  try {
    const bundle = await tree(options.bundle, 'bundle');
    const portable = await realpath(options.portable) === bundle.original ? bundle : await tree(options.portable, 'portable');
    const copied = { ...options, bundle: bundle.destination, portable: portable.destination };
    for (const key of ['manifest', 'authority', 'originalAuthority', 'targetPlan', 'sourceEvidence']) {
      if (!options[key]) continue;
      const original = resolve(options[key]);
      if (original.startsWith(`${bundle.original}${sep}`)) copied[key] = join(bundle.destination, relative(bundle.original, original));
      else { copied[key] = join(root, `${key}.json`); await copy(original, copied[key], 32 * 1024 * 1024); }
    }
    // Installed root and fence remain independent live references; neither can
    // be installed by the artifact or this derived snapshot.
    let closed = false;
    return {
      options: copied,
      seal: async () => {
        for (const record of records) {
          const path = join(root, record.path), entry = await lstat(path);
          await chmod(path, entry.mode & 0o111 ? 0o500 : 0o400);
        }
        for (const path of [...directories].sort((a, b) => b.length - a.length)) await chmod(path, 0o500);
      },
      measurements: { schema: 'shop.release-snapshot-cost/v1', files: records.length, copiedBytes,
        elapsedMs: Math.ceil(Number(process.hrtime.bigint() - started) / 1e6), inventoryDigest: sha256(Buffer.from(JSON.stringify(records))) },
      close: async () => {
        if (closed) return; closed = true;
        for (const path of directories) await chmod(path, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    for (const path of directories) await chmod(path, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true }); throw error;
  }
}
