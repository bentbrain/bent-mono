import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { canonical, check, filesUnder, parseJSON, readRegularFile, sha256 } from './data.mjs';
import { actionsIdentity } from './hosted-admission.mjs';
import { installProtectedPackage, requireInstalledOperation } from './protected-installation.mjs';
import { sealLinuxEvidence } from '../testing/linux-evidence.mjs';
import { saveHostedFailure } from './hosted-diagnostics.mjs';
import { packageHostedReleaseHistory } from './retained-history.mjs';

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
  const command = env.SHOP_COMPOSITION_COMMAND || 'plan';
  check(['plan', 'deliver', 'begin', 'advance', 'rollback', 'native-bootstrap', 'recover-report'].includes(command), 'Choose a supported protected workflow operation');
  let configuration, request = null;
  if (command === 'recover-report') {
    check(typeof env.SHOP_COMPOSITION_REPORTING_AUTHORITY === 'string' && Buffer.byteLength(env.SHOP_COMPOSITION_REPORTING_AUTHORITY) <= 1024 * 1024,
      'Provide the separately signed protected reporting authority');
    const authority = join(inputs, 'reporting-authority.private.json');
    await writeFile(authority, env.SHOP_COMPOSITION_REPORTING_AUTHORITY, { flag: 'wx', mode: 0o600 });
    configuration = { installationPath: installed.path, installationDigest: installed.digest, directory, command, recoveryAuthority: authority };
  } else {
    await requireInstalledOperation(installed.installation, command);
    if (command === 'deliver' || command === 'rollback') for (const operation of command === 'rollback' ? ['advance'] : ['begin', 'advance']) await requireInstalledOperation(installed.installation, operation);
    if (command === 'rollback') {
      check(installed.installation.historyIntake, 'Independently installed historical artifact admission required');
      const historyRequest = { runId: env.SHOP_HISTORY_RUN_ID, runAttempt: env.SHOP_HISTORY_RUN_ATTEMPT, artifactId: env.SHOP_HISTORY_ARTIFACT_ID, sourceCommit: env.SHOP_HISTORY_SOURCE_COMMIT };
      for (const field of ['runId', 'runAttempt', 'artifactId']) check(/^[1-9][0-9]{0,15}$/.test(historyRequest[field] ?? ''), 'Exact historical workflow artifact identity required');
      check(/^[a-f0-9]{40}$/.test(historyRequest.sourceCommit ?? '') && historyRequest.sourceCommit !== '0'.repeat(40), 'Exact original historical source required');
      configuration = { installationPath: installed.path, installationDigest: installed.digest, request: null, historyRequest, directory, command };
    } else {
      request = { runId: env.SHOP_ARTIFACT_RUN_ID, runAttempt: env.SHOP_ARTIFACT_RUN_ATTEMPT, artifactId: env.SHOP_ARTIFACT_ID, sourceCommit: identity.head };
      for (const field of ['runId', 'runAttempt', 'artifactId']) check(/^[1-9][0-9]{0,15}$/.test(request[field] ?? ''), 'Exact retained artifact identity required');
      configuration = { installationPath: installed.path, installationDigest: installed.digest, request, directory, command };
    }
  }
  if (command !== 'recover-report' && command !== 'rollback' && command !== 'native-bootstrap') {
    const values = ['SHOP_QUALIFICATION_RUN_ID', 'SHOP_QUALIFICATION_RUN_ATTEMPT', 'SHOP_QUALIFICATION_ARTIFACT_ID', 'SHOP_QUALIFICATION_SOURCE_COMMIT'].map(key => env[key]);
    if (values.some(value => value !== undefined && value !== '')) {
      check(installed.installation.historyIntake, 'Independently installed qualification artifact admission required');
      const [runId, runAttempt, artifactId, sourceCommit] = values;
      check([runId, runAttempt, artifactId].every(value => /^[1-9][0-9]{0,15}$/.test(value ?? '')) && /^[a-f0-9]{40}$/.test(sourceCommit ?? '') && sourceCommit !== '0'.repeat(40), 'Exact original native qualification workflow artifact required');
      configuration.qualificationRequest = { runId, runAttempt, artifactId, sourceCommit };
    }
  }
  await writeFile(paths.configuration, canonical(configuration), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'workflow-preparation.private.json'), canonical({ schema: 'shop.workflow-preparation/v1', identity, request,
    packageDigest: installed.packageDigest, installationDigest: installed.digest, command, ...(configuration.historyRequest ? { historyRequest: configuration.historyRequest } : {}), ...(configuration.qualificationRequest ? { qualificationRequest: configuration.qualificationRequest } : {}), operationalApproval: command !== 'plan', providerWrites: 0 }), { flag: 'wx', mode: 0o600 });
  return { configuration: paths.configuration, providerWrites: 0 };
}

export async function sealWorkflow(env = process.env) {
  const { identity, directory } = await locations(env), output = join(env.RUNNER_TEMP, 'shop-composition-sealed');
  const info = await lstat(directory);
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && await realpath(directory) === directory, 'Private workflow evidence required');
  const retainedParent = join(env.RUNNER_TEMP, 'shop-composition-retained'), retained = join(retainedParent, 'shop-composition-private');
  await mkdir(retainedParent, { mode: 0o700 }); await mkdir(retained, { mode: 0o700 });
  for (const path of ['workflow-preparation.private.json', 'result.private.json', 'transition.private.log']) {
    let bytes; try { bytes = await readRegularFile(join(directory, path), 32 * 1024 * 1024, true); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await writeFile(join(retained, path), bytes, { flag: 'wx', mode: 0o600 });
  }
  try {
    for (const path of await filesUnder(join(directory, 'diagnostics'))) {
      check(/^failure-[a-f0-9-]+\.private\.json$/.test(path), 'Unsupported workflow diagnostic file');
      const bytes = await readRegularFile(join(directory, 'diagnostics', path), 1024 * 1024, true);
      await mkdir(join(retained, 'diagnostics'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await writeFile(join(retained, 'diagnostics', path), bytes, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Retain the signed native subject and its source/request evidence, never installed files or mutable runtime caches.
  const nativeDirectory = join(directory, 'controller-evidence');
  try {
    for (const path of await filesUnder(nativeDirectory)) {
      if (!/^native-(?:source|authority|request-graph|qualification)-[a-f0-9]{64}\.json$/.test(path)) continue;
      const bytes = await readRegularFile(join(nativeDirectory, path), 16 * 1024 * 1024, true);
      await mkdir(join(retained, 'native-evidence'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await writeFile(join(retained, 'native-evidence', path), bytes, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let history = null, result, historyError;
  const preparation = parseJSON(await readRegularFile(join(retained, 'workflow-preparation.private.json'), 1024 * 1024, true));
  try { result = parseJSON(await readRegularFile(join(directory, 'result.private.json'), 32 * 1024 * 1024, true), 32 * 1024 * 1024); }
  catch { result = undefined; }
  if (preparation.command === 'deliver' && result?.controller?.phase === 'complete' && result.controller.lastVerified && result.controller.report?.eventDigest) {
    try { history = await packageHostedReleaseHistory({ verifiedReleaseFile: join(directory, 'verified-release.private.json'), result, identity, destination: join(retained, 'release-history') }); }
    catch (error) {
      historyError = error;
      // Only this new incomplete staging copy is removed; original runtime evidence stays intact.
      await rm(join(retained, 'release-history'), { recursive: true, force: true });
      await saveHostedFailure(error, join(retained, 'diagnostics'));
    }
  }
  const inventory = [];
  for (const path of await filesUnder(retained)) {
    const absolute = join(retained, path), entry = await lstat(absolute);
    check((entry.mode & 0o077) === 0 && entry.size <= 512 * 1024 * 1024, 'Bounded private workflow evidence file required');
    const bytes = await readRegularFile(absolute, 512 * 1024 * 1024, true);
    inventory.push({ path, bytes: bytes.length, sha256: sha256(bytes), executable: Boolean(entry.mode & 0o111) });
  }
  await writeFile(join(retained, 'workflow-inventory.private.json'), canonical({ schema: 'shop.workflow-evidence/v2', identity, inventory }), { flag: 'wx', mode: 0o600 });
  await mkdir(output, { mode: 0o700 });
  const archive = join(env.RUNNER_TEMP, 'shop-composition-private.tar.gz');
  try {
    await execute('tar', [`--format=${process.platform === 'darwin' ? 'ustar' : 'gnu'}`, '-czf', archive, 'shop-composition-private'], { cwd: retainedParent, timeout: 240000, maxBuffer: 65536 });
    const recipient = JSON.parse(await readFile(new URL('../testing/linux-evidence-recipient.json', import.meta.url), 'utf8'));
    await sealLinuxEvidence(archive, join(output, 'composition-evidence.tar.gz.enc'), { sourceCommit: identity.head, runId: identity.runId, filename: 'composition-evidence.json' }, recipient);
  } finally { await rm(archive, { force: true }); }
  if (historyError) throw historyError;
  return { sealed: true, files: inventory.length, historicalReleaseRetained: history !== null };
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
