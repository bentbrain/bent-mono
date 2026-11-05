import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
void test('real JapanMap SSR preserves 600 and 1200 photos without accessing dimension bindings', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    'tests/fixtures/map-ssr.mjs',
  ]);
  console.log(stdout.trim());
});
