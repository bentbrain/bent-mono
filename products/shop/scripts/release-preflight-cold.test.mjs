import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('early native preflight validates requests without installed workspace dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-preflight-cold-'));
  try {
    cpSync(new URL('./', import.meta.url), join(directory, 'scripts'), { recursive: true });
    mkdirSync(join(directory, 'apps/web'), { recursive: true });
    cpSync(new URL('../apps/web/scripts/', import.meta.url), join(directory, 'apps/web/scripts'), { recursive: true });
    mkdirSync(join(directory, 'infra/story-video-lambda'), { recursive: true });
    cpSync(new URL('../infra/story-video-lambda/production-promotion.json', import.meta.url),
      join(directory, 'infra/story-video-lambda/production-promotion.json'));
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { offlinePreflight } from './scripts/release-preflight.mjs';
      import { NATIVE_MIGRATION_COUNT, NATIVE_MIGRATION_LATEST } from './scripts/native-migration-inventory.mjs';
      import { providerIdentityIsolated } from './scripts/provider-identity-isolation.mjs';
      const migrations = Array.from({ length: NATIVE_MIGRATION_COUNT }, (_, i) => i + '.sql');
      migrations[migrations.length - 1] = NATIVE_MIGRATION_LATEST;
      const request = { environment: 'development', lane: 'native', operation: 'release',
        ref: 'refs/heads/main', sha: 'a'.repeat(40), migrations };
      assert.equal(offlinePreflight(request).passed, true);
      assert.equal(offlinePreflight(request).admissionGranted, false);
      assert.equal(offlinePreflight({ ...request, ref: 'refs/heads/untrusted' }).passed, false);
      assert.equal(offlinePreflight({ ...request, operation: 'qualify-all' }).passed, false);
      assert.throws(() => providerIdentityIsolated('import { Schema } from "effect";'),
        error => error.code === 'MODULE_NOT_FOUND');
    `], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
