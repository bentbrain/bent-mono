import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRef, sha256 } from './data.mjs';
import { snapshotRelease } from './release-snapshot.mjs';

async function fixture(t) {
  const base = process.env.SHOP_BOOTSTRAP_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(base, 'release-snapshot-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle'), portable = join(root, 'portable'), evidenceDirectory = join(root, 'evidence');
  for (const directory of [bundle, portable, evidenceDirectory]) await mkdir(directory, { mode: 0o700 });
  await mkdir(join(bundle, 'payload'), { mode: 0o700 });
  for (const path of ['entry.mjs', 'entry.mjs.map', 'module.wasm', 'asset.bin']) await writeFile(join(bundle, 'payload', path), `original-${path}`, { mode: 0o600 });
  await writeFile(join(bundle, 'release-composition.json'), '{}', { mode: 0o600 });
  await writeFile(join(bundle, 'release-authority.json'), '{}', { mode: 0o600 });
  await writeFile(join(portable, 'portable-bundle.json'), '{}', { mode: 0o600 });
  const targetPlan = join(root, 'plan.json'); await writeFile(targetPlan, '{}', { mode: 0o600 });
  return { root, options: { bundle, portable, evidenceDirectory, targetPlan, manifest: join(bundle, 'release-composition.json'), authority: join(bundle, 'release-authority.json'), trustRoot: join(root, 'independent-root.json'), fence: join(root, 'fence.json') } };
}

test('a session retains exact private bytes including maps, Wasm and assets independently of caller paths', async t => {
  const f = await fixture(t), snapshot = await snapshotRelease(f.options); t.after(() => snapshot.close());
  assert.equal(snapshot.options.trustRoot, f.options.trustRoot); assert.equal(snapshot.options.fence, f.options.fence);
  assert.notEqual(snapshot.options.targetPlan, f.options.targetPlan);
  await snapshot.seal();
  for (const path of ['entry.mjs', 'entry.mjs.map', 'module.wasm', 'asset.bin']) {
    const bytes = Buffer.from(`original-${path}`), ref = { path: `payload/${path}`, bytes: bytes.length, sha256: sha256(bytes) };
    await writeFile(join(f.options.bundle, ref.path), 'changed caller bytes');
    assert.deepEqual(await readRef(snapshot.options.bundle, ref), bytes);
  }
  assert(snapshot.measurements.copiedBytes > 0); assert.equal(snapshot.measurements.files, 8);
  const path = join(snapshot.options.bundle, 'payload/entry.mjs'); await chmod(path, 0o600); await writeFile(path, 'altered snapshot');
  const bytes = Buffer.from('original-entry.mjs');
  await assert.rejects(readRef(snapshot.options.bundle, { path: 'payload/entry.mjs', bytes: bytes.length, sha256: sha256(bytes) }), /Referenced bytes differ/);
  await snapshot.close(); await assert.rejects(readFile(snapshot.options.manifest), { code: 'ENOENT' });
});

test('symlinked artifact or control bytes cannot enter a verified session snapshot', async t => {
  const f = await fixture(t);
  await assert.rejects(snapshotRelease({ ...f.options, evidenceDirectory: join(process.cwd(), 'private-snapshot-test') }), /outside source/);
  await symlink(f.options.targetPlan, join(f.options.bundle, 'unexpected.json'));
  await assert.rejects(snapshotRelease(f.options), /Symlinks/);
  await rm(join(f.options.bundle, 'unexpected.json')); await rm(f.options.targetPlan);
  await symlink(f.options.manifest, f.options.targetPlan);
  await assert.rejects(snapshotRelease(f.options), /ELOOP|symbolic|regular/);
});
