import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveHostedFailure } from './hosted-diagnostics.mjs';
import { sha256 } from './data.mjs';

test('failed hosted calls retain bounded causal diagnostics privately and refuse source destinations', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hosted-diagnostics-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cause = Error('provider detail'), error = Error('upload acknowledgement missing', { cause }); error.operation = 'worker.upload';
  const saved = await saveHostedFailure(error, directory), bytes = await readFile(saved.path), value = JSON.parse(bytes);
  assert.equal(saved.sha256, sha256(bytes)); assert.equal(value.causes[1].message, cause.message);
  assert.equal(value.causes[0].operation, error.operation); assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  await assert.rejects(saveHostedFailure(error, process.cwd()), /outside source/);
});
