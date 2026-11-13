// Synthetic payloads for portable import and signed authority tests.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../data.mjs';
import { packagePortableBundle } from '../portable-bundle.mjs';

export async function createPortableFixture(t, { lineage = { kind: 'local-source-build', sourceCommit: '1'.repeat(40), dirtySnapshot: true }, rootDirectory = tmpdir() } = {}) {
  const root = await mkdtemp(join(rootDirectory, 'shop-portable-bundle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source, { mode: 0o700 });
  const workspaceRoots = ['products/shop/workers/api', 'products/shop/packages/product-image-renderer', 'products/shop/workers/video-renderer', 'products/shop/apps/storefront', 'products/shop/apps/web', 'packages/ui', 'packages/design-tokens'];
  const lock = { lockfileVersion: 3, configVersion: 1, packages: {}, workspaces: { '': { name: 'root' }, ...Object.fromEntries(workspaceRoots.map((path, index) => [path, { name: `workspace-${index}` }])) } };
  const files = [];
  for (const [path, bytes] of [['package.json', '{}'], ['bun.lock', JSON.stringify(lock)], ['products/shop/workers/api/src/index.ts', 'export default {};'], ['a/z.js', 'export {};'], ['a-other.js', 'export {};']]) {
    await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), bytes);
    files.push({ path, sha256: sha256(bytes), mode: '100644' });
  }
  files.sort((a, b) => a.path < b.path ? -1 : 1);
  const components = [];
  for (const id of ['business', 'native', 'storefront']) {
    const directory = join(root, id); await mkdir(directory, { mode: 0o700 });
    for (const [name, bytes] of [['index.js', `export const component = '${id}';`], ['index.js.map', '{}'], ['engine.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])], ['assets/font.woff2', 'synthetic font fixture']]) {
      await mkdir(join(directory, name, '..'), { recursive: true }); await writeFile(join(directory, name), bytes);
    }
    components.push({ id, directory, entrypoint: 'index.js', originSourceCommit: lineage.sourceCommit, runtime: { kind: 'synthetic-test-runtime', awsImageQualified: false } });
  }
  const originSourceCommit = lineage.sourceCommit;
  const verified = await packagePortableBundle({ destination: join(root, 'bundle'), originSourceCommit, lineage, sourceInventory: { files }, sourceDirectory: source, components });
  return { root, verified, source, components };
}
