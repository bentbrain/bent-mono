import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { githubApi } from '../../../../scripts/require-release-checks.mjs';
import { canonical, check, digest, parseJSON, readRegularFile, same } from './data.mjs';
import { actionsIdentity } from './hosted-admission.mjs';
import { importHostedPortable } from './artifact-intake.mjs';
import { readProtectedInstallation, readReportingInstallation } from './protected-installation.mjs';
import { assembleHostedRelease } from './source-issuance.mjs';
import { hostedController } from './hosted-controller.mjs';
import { saveHostedFailure } from './hosted-diagnostics.mjs';

const checkout = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const commands = new Set(['plan', 'advance', 'begin', 'rollback', 'recover-report']);
async function privateDirectory(path) {
  check(typeof path === 'string' && path === resolve(path) && path !== checkout && !path.startsWith(`${checkout}${sep}`), 'Absolute private workflow directory outside source required');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  check(entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o777) === 0o700 && await realpath(path) === path &&
    (typeof process.getuid !== 'function' || entry.uid === process.getuid()), 'Owned private workflow directory required');
}

/** One process owns each transition. Protected journal recovery never replays writes. */
export async function workflowEntrypoint(options, boundaries = {}) {
  if (options.command === 'deliver') return deliverWorkflow(options, boundaries);
  const { installationPath, installationDigest, request, directory, command = 'plan', acceptedAt, env = process.env } = options;
  check(commands.has(command), 'Unsupported workflow transition');
  const identity = actionsIdentity(env), planOnly = command === 'plan', evidenceDirectory = join(directory, planOnly ? 'plan-evidence' : 'controller-evidence');
  const installedOptions = { path: installationPath, digest: installationDigest, identity, artifactDirectories: [directory] };
  if (command === 'recover-report') {
    check(typeof options.recoveryAuthority === 'string', 'Provide separately approved reporting authority');
    const installed = await readReportingInstallation(installedOptions);
    await privateDirectory(directory); await privateDirectory(evidenceDirectory);
    const controller = await hostedController({ command, authority: options.recoveryAuthority, trustRoot: installed.rootPath,
      rootDigest: installed.rootDigest, fence: installed.fencePath, evidenceDirectory, env }, boundaries);
    return { controller, paths: { authority: options.recoveryAuthority }, readiness: { realProviderQualificationRequired: true } };
  }
  const installation = await readProtectedInstallation(installedOptions);
  check(request?.sourceCommit === identity.head, 'Artifact source differs from canonical workflow source');
  await privateDirectory(directory);
  const lock = join(directory, 'invocation.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    const statePath = join(directory, planOnly ? 'plan-state.private.json' : 'workflow-state.private.json'), bundle = join(directory, planOnly ? 'plan-assembly' : 'assembly');
    const intakeDirectory = join(directory, planOnly ? 'plan-intake' : 'intake');
    let state;
    try { state = parseJSON(await readRegularFile(statePath, 1024 * 1024, true)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const subject = { installationDigest, identity, request };
    let assembled;
    if (state) {
      check(state.schema === 'shop.workflow-state/v1' && state.subjectDigest === digest(subject) && same(state.subject, subject), 'Saved workflow invocation differs');
      const paths = { bundle, manifest: join(bundle, 'release-composition.json'), authority: join(bundle, 'release-authority.json') };
      check(Object.entries(paths).every(([key, value]) => state.options[key] === value) && state.options.portable === join(intakeDirectory, 'evidence/shop-linux-private/portable-release') &&
        state.options.trustRoot === installation.rootPath && state.options.rootDigest === installation.rootDigest && state.options.targetPlan === installation.planPath &&
        state.options.fence === installation.fencePath && state.options.evidenceDirectory === evidenceDirectory, 'Saved workflow paths differ from protected installation');
      assembled = { options: state.options, readiness: state.readiness, evidence: state.evidence };
    } else {
      await privateDirectory(evidenceDirectory);
      const imported = await importHostedPortable({ request, installation: installation.artifactIntake, destination: intakeDirectory,
        privateKeyFile: installation.artifactPrivateKeyFile, ...(boundaries.intakeApi ? { api: boundaries.intakeApi } : env.GH_TOKEN ? { githubToken: env.GH_TOKEN } : {}) });
      assembled = await assembleHostedRelease({ installation, identity, imported, destination: bundle, evidenceDirectory,
        qualityApi: boundaries.qualityApi ?? githubApi, acceptedAt, command, env, boundaries });
      state = { schema: 'shop.workflow-state/v1', subject, subjectDigest: digest(subject), options: assembled.options,
        readiness: assembled.readiness, evidence: assembled.evidence };
      await writeFile(statePath, canonical(state), { flag: 'wx', mode: 0o600 });
    }
    const controller = await hostedController({ ...assembled.options, command, env }, boundaries);
    return { controller, paths: assembled.options, readiness: assembled.readiness, evidence: assembled.evidence };
  } finally { await rm(lock, { recursive: true }); }
}

/** Complete bounded forward transitions; an uncertain acknowledgement stops the run. */
export async function deliverWorkflow(options, boundaries = {}) {
  check(typeof options.directory === 'string', 'Private workflow directory required');
  let command = 'begin';
  try { await lstat(join(options.directory, 'workflow-state.private.json')); command = 'advance'; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const transitions = []; let previousGeneration = null, result;
  for (let count = 0; count < 96; count++) {
    result = await workflowEntrypoint({ ...options, command }, boundaries);
    const state = result.controller;
    transitions.push({ phase: state.phase, generation: state.generation ?? null, compositionDigest: state.compositionDigest });
    if (state.phase === 'complete' || state.waiting) return { ...result, transitions };
    check(Number.isSafeInteger(state.generation) && (previousGeneration === null || state.generation > previousGeneration), 'Controller transition made no durable progress');
    previousGeneration = state.generation; command = 'advance';
  }
  return { ...result, controller: { ...result.controller, waiting: 'bounded-transition-limit' }, transitions };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, options: { configuration: { type: 'string' } } });
  check(values.configuration, 'Provide a protected workflow configuration file');
  const options = parseJSON(await readRegularFile(resolve(values.configuration), 1024 * 1024, true));
  check(!Object.hasOwn(options, 'env') && !Object.hasOwn(options, 'boundaries'), 'Workflow identity and provider boundaries come from protected runtime');
  return workflowEntrypoint(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(`${canonical(result)}\n`)).catch(async error => {
    try {
      const at = process.argv.indexOf('--configuration'), options = at < 0 ? null : parseJSON(await readRegularFile(resolve(process.argv[at + 1]), 1024 * 1024, true));
      const record = await saveHostedFailure(error, options?.directory && join(options.directory, 'diagnostics'));
      process.stderr.write(`Workflow transition failed. Private diagnostic ${record.sha256}. Reconcile the retained attempt before another write.\n`);
    } catch { process.stderr.write('Workflow transition failed. Preserve the private runner output before continuing.\n'); }
    process.exitCode = 1;
  });
}
