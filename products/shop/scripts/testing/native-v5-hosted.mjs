import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkout, packageLinuxCandidate, packageNativeV5Oci, packageShopPortableBundle, sha256 } from './linux-candidate.mjs';
import { saveHostedFailure } from '../release-v2/hosted-diagnostics.mjs';
import { retrieveNativeBaseOci } from './native-v5-base.mjs';

const execute = promisify(execFile), env = process.env;
assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.GITHUB_REPOSITORY, 'bentbrain/bent-mono'); assert.equal(env.GITHUB_JOB, 'producer');
assert.match(env.SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/); assert.equal(env.PRIVATE_EVIDENCE, join(env.RUNNER_TEMP, 'shop-linux-private'));
assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim(), env.SOURCE_COMMIT); process.umask(0o077);
const json = value => JSON.stringify(value, null, 2) + '\n';

async function produce() {
  const candidate = join(env.PRIVATE_EVIDENCE, 'candidate'), nativeOci = join(env.RUNNER_TEMP, 'shop-native-oci');
  await packageLinuxCandidate(candidate);
  const base = await retrieveNativeBaseOci(join(env.RUNNER_TEMP, 'shop-native-base'));
  const image = await packageNativeV5Oci({ candidate, baseDirectory: join(env.RUNNER_TEMP, 'shop-native-base'), destination: nativeOci });
  const lineage = { kind: 'github-actions', repository: env.GITHUB_REPOSITORY, sourceCommit: env.SOURCE_COMMIT, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, workflowRef: env.GITHUB_WORKFLOW_REF, jobId: env.GITHUB_JOB };
  const portable = await packageShopPortableBundle({ candidate, nativeOci, destination: join(env.PRIVATE_EVIDENCE, 'portable-release'), originSourceCommit: env.SOURCE_COMMIT, lineage });
  await writeFile(join(env.PRIVATE_EVIDENCE, 'generated-storefront-routeTree.private.ts'), await readFile(join(checkout, 'products/shop/apps/storefront/src/routeTree.gen.ts')), { flag: 'wx', mode: 0o600 });
  const expected = join(env.PRIVATE_EVIDENCE, 'portable-release-identity.private.json');
  await writeFile(expected, json({ manifestSha256: portable.manifestSha256, originSourceCommit: env.SOURCE_COMMIT, lineage, requireHostedLineage: true }), { flag: 'wx', mode: 0o600 });
  const log = await open(join(env.PRIVATE_EVIDENCE, 'journey.private.log'), 'wx', 0o600);
  try {
    const result = await execute(join(candidate, 'runtime/bin/node'), [join(checkout, 'products/shop/scripts/testing/linux-journey.mjs'), candidate,
      join(env.PRIVATE_EVIDENCE, 'journey'), portable.root, expected], { cwd: checkout, timeout: 600000, maxBuffer: 1024 * 1024,
      env: { PATH: env.PATH, HOME: env.HOME, CI: 'true', TMPDIR: env.TMPDIR ?? '/tmp', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' } });
    await log.write(result.stdout); await log.write(result.stderr);
  } catch (error) { await log.write(error.stdout ?? ''); await log.write(error.stderr ?? ''); throw Error('Native OCI journey failed; inspect encrypted evidence.'); }
  finally { await log.close(); }
  const receiptBytes = await readFile(join(env.PRIVATE_EVIDENCE, 'journey/linux-j01.private.json')), receipt = JSON.parse(receiptBytes.toString('utf8'));
  assert.equal(receipt.complete, true); assert.equal(receipt.portableManifestSha256, portable.manifestSha256); assert.equal(receipt.sourceCommit, env.SOURCE_COMMIT);
  assert.equal(receipt.dirtySnapshot, false); assert.equal(receipt.awsImageQualified, false); assert.equal(receipt.ociContainerStartupVerified, false);
  await writeFile(join(env.PRIVATE_EVIDENCE, 'native-oci-producer.private.json'), json({ schema: 'shop.hosted-native-oci-producer/v1', lineage,
    portableManifestSha256: portable.manifestSha256, imageDigest: image.imageDigest, base, receipt: image.receipt,
    journeySha256: sha256(receiptBytes), ociContainerStartupVerified: false, runtimeQualified: false, awsImageQualified: false, productionQualified: false }), { mode: 0o600, flag: 'wx' });
  console.info(json({ sourceCommit: env.SOURCE_COMMIT, portableManifestSha256: portable.manifestSha256, imageDigest: image.imageDigest, complete: true, awsImageQualified: false }));
}

try { assert.equal(process.argv.length, 2); await produce(); }
catch (error) {
  await saveHostedFailure(error, join(env.PRIVATE_EVIDENCE, 'diagnostics')).catch(() => {});
  console.error('Native OCI production failed. Inspect the encrypted evidence.'); process.exitCode = 1;
}
