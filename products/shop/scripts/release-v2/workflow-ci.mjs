import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { canonical, check, filesUnder, readRegularFile, sha256 } from './data.mjs';
import { actionsIdentity } from './hosted-admission.mjs';
import { installProtectedPackage } from './protected-installation.mjs';
import { sealLinuxEvidence } from '../testing/linux-evidence.mjs';
import { saveHostedFailure } from './hosted-diagnostics.mjs';

const execute = promisify(execFile);
async function locations(env) {
  check(typeof env.RUNNER_TEMP === 'string' && env.RUNNER_TEMP === resolve(env.RUNNER_TEMP) && await realpath(env.RUNNER_TEMP) === env.RUNNER_TEMP, 'Canonical runner temporary directory required');
  const identity = actionsIdentity(env), inputs = join(env.RUNNER_TEMP, 'shop-composition-inputs'), directory = join(env.RUNNER_TEMP, 'shop-composition-private');
  return { identity, inputs, directory, configuration: join(inputs, 'configuration.private.json') };
}

export async function prepareWorkflow(env = process.env) {
  const paths = await locations(env), { identity, inputs, directory } = paths;
  check(typeof env.SHOP_COMPOSITION_INSTALLATION_PACKAGE === 'string' && Buffer.byteLength(env.SHOP_COMPOSITION_INSTALLATION_PACKAGE) > 0 &&
    Buffer.byteLength(env.SHOP_COMPOSITION_INSTALLATION_PACKAGE) <= 32 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(env.SHOP_COMPOSITION_INSTALLATION_PACKAGE_SHA256 ?? ''), 'Protected installation package and independent digest required');
  const bytes = Buffer.from(env.SHOP_COMPOSITION_INSTALLATION_PACKAGE);
  check(sha256(bytes) === env.SHOP_COMPOSITION_INSTALLATION_PACKAGE_SHA256, 'Protected package bytes differ');
  await mkdir(inputs, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  const path = join(inputs, 'package.private.json'); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  const installed = await installProtectedPackage({ path, digest: env.SHOP_COMPOSITION_INSTALLATION_PACKAGE_SHA256,
    destination: join(inputs, 'installed'), identity, artifactDirectories: [directory] });
  const request = { runId: env.SHOP_ARTIFACT_RUN_ID, runAttempt: env.SHOP_ARTIFACT_RUN_ATTEMPT, artifactId: env.SHOP_ARTIFACT_ID, sourceCommit: identity.head };
  for (const field of ['runId', 'runAttempt', 'artifactId']) check(/^[1-9][0-9]{0,15}$/.test(request[field] ?? ''), 'Exact retained artifact identity required');
  const configuration = { installationPath: installed.path, installationDigest: installed.digest, request, directory, command: 'plan' };
  await writeFile(paths.configuration, canonical(configuration), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'workflow-preparation.private.json'), canonical({ schema: 'shop.workflow-preparation/v1', identity, request,
    packageDigest: installed.packageDigest, installationDigest: installed.digest, operationalApproval: false, providerWrites: 0 }), { flag: 'wx', mode: 0o600 });
  return { configuration: paths.configuration, providerWrites: 0 };
}

export async function sealWorkflow(env = process.env) {
  const { identity, directory } = await locations(env), output = join(env.RUNNER_TEMP, 'shop-composition-sealed');
  const info = await lstat(directory);
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && await realpath(directory) === directory, 'Private workflow evidence required');
  const inventory = [];
  for (const path of await filesUnder(directory)) {
    const absolute = join(directory, path), entry = await lstat(absolute);
    check((entry.mode & 0o077) === 0 && entry.size <= 512 * 1024 * 1024, 'Bounded private workflow evidence file required');
    const bytes = await readRegularFile(absolute, 512 * 1024 * 1024, true);
    inventory.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await writeFile(join(directory, 'workflow-inventory.private.json'), canonical({ schema: 'shop.workflow-evidence/v1', identity, inventory }), { flag: 'wx', mode: 0o600 });
  await mkdir(output, { mode: 0o700 });
  const archive = join(env.RUNNER_TEMP, 'shop-composition-private.tar.gz');
  await execute('tar', ['-czf', archive, 'shop-composition-private'], { cwd: env.RUNNER_TEMP, timeout: 240000, maxBuffer: 65536 });
  const recipient = JSON.parse(await readFile(new URL('../testing/linux-evidence-recipient.json', import.meta.url), 'utf8'));
  await sealLinuxEvidence(archive, join(output, 'composition-evidence.tar.gz.enc'), { sourceCommit: identity.head, runId: identity.runId, filename: 'composition-evidence.json' }, recipient);
  return { sealed: true, files: inventory.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const operation = process.argv[2];
  Promise.resolve().then(() => { check(process.argv.length === 3 && ['prepare', 'seal'].includes(operation), 'Choose prepare or seal'); return operation === 'prepare' ? prepareWorkflow() : sealWorkflow(); })
    .then(result => process.stdout.write(`${canonical(result)}\n`)).catch(async error => {
      try { const record = await saveHostedFailure(error, process.env.RUNNER_TEMP && join(process.env.RUNNER_TEMP, 'shop-composition-private/diagnostics')); process.stderr.write(`Protected workflow failed. Private diagnostic ${record.sha256}.\n`); }
      catch { process.stderr.write('Protected workflow failed. Preserve the private runner evidence.\n'); }
      process.exitCode = 1;
    });
}
