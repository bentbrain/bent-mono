import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyNativeRuntimeSource, copyNativeRuntimeDependencies } from './linux-candidate.mjs';

const execute = promisify(execFile);
test('actual retained native entrypoints have their complete static module closure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-runtime-closure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyNativeRuntimeSource(directory);
  const capsule = join(directory, "native-image");
  await execute(process.execPath, [fileURLToPath(new URL("./product-image-v5-capsule.mjs", import.meta.url)), capsule], { timeout: 30000, maxBuffer: 16384 });
  await copyNativeRuntimeDependencies(directory, capsule);
  const entries = ['app-handler.mjs', 'app-entry.mjs', 'failure-entry.mjs'];
  const fixture = await readFile(new URL('../protected-config.fixtures.json', import.meta.url), 'utf8');
  const urls = entries.map(file => pathToFileURL(join(directory, 'products/shop/workers/video-renderer/aws-lambda', file)).href);
  const result = await execute(process.execPath, ['--input-type=module', '-e',
    'for (const url of process.argv.slice(1)) await import(url); console.log("complete static native imports");', ...urls], {
    env: { SHOP_PROTECTED_CONFIG_JSON: fixture }, timeout: 10000, maxBuffer: 16384,
  });
  assert.equal(result.stdout.trim(), 'complete static native imports');
});
