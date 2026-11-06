import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

void test('production content dependencies load in Workers without losing HTML sanitization', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    'tests/fixtures/worker-content-bundle.mjs',
  ]);
  console.log(stdout.trim());
});
