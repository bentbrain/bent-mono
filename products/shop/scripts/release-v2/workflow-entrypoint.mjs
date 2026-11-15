import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { channel } from 'node:diagnostics_channel';
import { githubApi } from '../../../../scripts/require-release-checks.mjs';
import { canonical, check, digest, parseJSON, readRegularFile, same } from './data.mjs';
import { actionsIdentity } from './hosted-admission.mjs';
import { importHostedPortable } from './artifact-intake.mjs';
import { importHostedReleaseHistory, assertHostedReleaseHistory, importHostedNativeQualificationReceipt, assertHostedNativeQualificationReceipt } from './retained-history.mjs';
import { readProtectedInstallation, readReportingInstallation, requireInstalledOperation } from './protected-installation.mjs';
import { assembleHostedRelease, assembleHostedRollback, executeHostedNativeQualification } from './source-issuance.mjs';
import { hostedController, withHostedReleaseSession } from './hosted-controller.mjs';
import { saveHostedFailure } from './hosted-diagnostics.mjs';

const checkout = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const commands = new Set(['plan', 'advance', 'begin', 'rollback', 'native-bootstrap', 'recover-report']);
const trace = channel('shop.release-v2.workflow');
const deliverSession = Symbol('admitted release session');
async function privateDirectory(path) {
  check(typeof path === 'string' && path === resolve(path) && path !== checkout && !path.startsWith(`${checkout}${sep}`), 'Absolute private workflow directory outside source required');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  check(entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o777) === 0o700 && await realpath(path) === path &&
    (typeof process.getuid !== 'function' || entry.uid === process.getuid()), 'Owned private workflow directory required');
}

/** Protected journal recovery never replays an uncertain write. */
export async function workflowEntrypoint(options, boundaries = {}) {
  if (options.command === 'deliver' || options.command === 'rollback' && !options.transitionOnly) return deliverWorkflow(options, boundaries);
  const { installationPath, installationDigest, request, directory, command = 'plan', acceptedAt, env = process.env } = options;
  check(commands.has(command), 'Unsupported workflow transition');
  trace.publish({ step: 'entrypoint-start', command });
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
  await requireInstalledOperation(installation, command);
  check(command === 'rollback' || options.historyRequest || options.rollbackDirectory || request?.sourceCommit === identity.head, 'Artifact source differs from canonical workflow source');
  await privateDirectory(directory);
  if (command === 'native-bootstrap') {
    const lock = join(directory, 'invocation.lock'); await mkdir(lock, { mode: 0o700 });
    try {
      await privateDirectory(evidenceDirectory);
      const imported = await importHostedPortable({ request, installation: installation.artifactIntake, destination: join(directory, 'native-intake'),
        privateKeyFile: installation.artifactPrivateKeyFile, ...(boundaries.intakeApi ? { api: boundaries.intakeApi } : env.GH_TOKEN ? { githubToken: env.GH_TOKEN } : {}) });
      return await executeHostedNativeQualification({ installation, identity, imported, evidenceDirectory,
        qualityApi: boundaries.qualityApi ?? githubApi, acceptedAt, env, boundaries });
    } finally { await rm(lock, { recursive: true }); }
  }
  if (command === 'rollback' || options.rollbackDirectory || options.historyRequest) {
    await privateDirectory(evidenceDirectory);
    check(typeof options.rollbackDirectory === 'string' !== Boolean(options.historyRequest), 'Provide one retained release directory or authenticated history request');
    const statePath = join(directory, 'rollback-state.private.json'), subject = { installationDigest, identity, ...(options.historyRequest ? { historyRequest: options.historyRequest } : { rollbackDirectory: options.rollbackDirectory }) };
    let assembled;
    try {
      const state = parseJSON(await readRegularFile(statePath, 1024 * 1024, true));
      check(state.schema === 'shop.workflow-rollback-state/v1' && same(state.subject, subject), 'Saved rollback invocation differs');
      assembled = state.assembled;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      check(command === 'rollback', 'Begin historical rollback before advancing');
      let rollbackDirectory = options.rollbackDirectory;
      if (options.historyRequest) {
        check(installation.historyIntake, 'Independently installed history intake required');
        const imported = await importHostedReleaseHistory({ request: options.historyRequest, installation: { ...installation.historyIntake, githubConfigDirectory: installation.artifactIntake.githubConfigDirectory },
          privateKeyFile: installation.artifactPrivateKeyFile, destination: join(directory, 'history-intake'),
          ...(boundaries.historyApi ? { api: boundaries.historyApi } : env.GH_TOKEN ? { githubToken: env.GH_TOKEN } : {}) });
        rollbackDirectory = (await assertHostedReleaseHistory(imported)).rollbackDirectory;
      }
      assembled = await assembleHostedRollback({ installation, identity, rollbackDirectory, evidenceDirectory,
        qualityApi: boundaries.qualityApi ?? githubApi, acceptedAt, env, boundaries });
      await writeFile(statePath, canonical({ schema: 'shop.workflow-rollback-state/v1', subject, assembled }), { flag: 'wx', mode: 0o600 });
    }
    check(assembled.options.trustRoot === installation.rootPath && assembled.options.rootDigest === installation.rootDigest &&
      assembled.options.targetPlan === installation.planPath && assembled.options.fence === installation.fencePath &&
      assembled.options.evidenceDirectory === evidenceDirectory, 'Saved rollback paths differ from protected installation');
    const controller = options[deliverSession] ? await options[deliverSession](assembled, installation) : await hostedController({ ...assembled.options, command, env }, boundaries);
    return { controller, paths: assembled.options, readiness: assembled.readiness, evidence: assembled.evidence };
  }
  const lock = join(directory, 'invocation.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    const statePath = join(directory, planOnly ? 'plan-state.private.json' : 'workflow-state.private.json'), bundle = join(directory, planOnly ? 'plan-assembly' : 'assembly');
    const intakeDirectory = join(directory, planOnly ? 'plan-intake' : 'intake');
    let state;
    try { state = parseJSON(await readRegularFile(statePath, 1024 * 1024, true)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const subject = { installationDigest, identity, request, ...(options.qualificationRequest ? { qualificationRequest: options.qualificationRequest } : {}) };
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
      trace.publish({ step: 'intake-start', command });
      const imported = await importHostedPortable({ request, installation: installation.artifactIntake, destination: intakeDirectory,
        privateKeyFile: installation.artifactPrivateKeyFile, ...(boundaries.intakeApi ? { api: boundaries.intakeApi } : env.GH_TOKEN ? { githubToken: env.GH_TOKEN } : {}) });
      trace.publish({ step: 'intake-complete', command });
      const nativeQualificationReceipts = [];
      if (options.qualificationRequest) {
        check(installation.historyIntake, 'Independently installed native qualification receipt intake required');
        const receipt = await importHostedNativeQualificationReceipt({ request: options.qualificationRequest, installation: { ...installation.historyIntake, githubConfigDirectory: installation.artifactIntake.githubConfigDirectory },
          privateKeyFile: installation.artifactPrivateKeyFile, destination: join(directory, planOnly ? 'plan-qualification-intake' : 'qualification-intake'), root: installation.root, expected: {},
          ...(boundaries.historyApi ? { api: boundaries.historyApi } : env.GH_TOKEN ? { githubToken: env.GH_TOKEN } : {}) });
        nativeQualificationReceipts.push((await assertHostedNativeQualificationReceipt(receipt, { root: installation.root, expected: {} })).receipt);
      }
      trace.publish({ step: 'assembly-start', command });
      assembled = await assembleHostedRelease({ installation, identity, imported, destination: bundle, evidenceDirectory,
        qualityApi: boundaries.qualityApi ?? githubApi, acceptedAt, command, env, boundaries, nativeQualificationReceipts });
      trace.publish({ step: 'assembly-complete', command });
      state = { schema: 'shop.workflow-state/v1', subject, subjectDigest: digest(subject), options: assembled.options,
        readiness: assembled.readiness, evidence: assembled.evidence };
      await writeFile(statePath, canonical(state), { flag: 'wx', mode: 0o600 });
    }
    trace.publish({ step: 'controller-start', command });
    const controller = options[deliverSession] ? await options[deliverSession](assembled, installation) : await hostedController({ ...assembled.options, command, env }, boundaries);
    trace.publish({ step: 'controller-complete', command, phase: controller.phase });
    if (controller.report?.eventDigest && controller.lastVerified && digest(controller.lastVerified) === controller.compositionDigest) {
      const verifiedPath = join(directory, 'verified-release.private.json');
      try { await writeFile(verifiedPath, canonical({ schema: 'shop.verified-workflow-release/v1', options: assembled.options,
        eventDigest: controller.report.eventDigest, compositionDigest: controller.compositionDigest }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return { controller, paths: assembled.options, readiness: assembled.readiness, evidence: assembled.evidence };
  } finally { await rm(lock, { recursive: true }); }
}

/** Complete bounded forward transitions; an uncertain acknowledgement stops the run. */
export async function deliverWorkflow(options, boundaries = {}) {
  check(typeof options.directory === 'string', 'Private workflow directory required');
  const identity = actionsIdentity(options.env ?? process.env);
  const installation = await readProtectedInstallation({ path: options.installationPath, digest: options.installationDigest, identity, artifactDirectories: [options.directory] });
  for (const operation of options.command === 'rollback' ? ['rollback', 'advance'] : ['deliver', 'begin', 'advance']) await requireInstalledOperation(installation, operation);
  let command = options.command === 'rollback' ? 'rollback' : 'begin';
  try { await lstat(join(options.directory, options.command === 'rollback' ? 'rollback-state.private.json' : 'workflow-state.private.json')); command = 'advance'; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const transitions = []; let previousGeneration = null, sessionMeasurements;
  const result = await workflowEntrypoint({ ...options, command, transitionOnly: true, [deliverSession]: async (assembled, installed) =>
    withHostedReleaseSession({ ...assembled.options, command, env: options.env ?? process.env }, boundaries, async (step, measurements) => {
      let state;
      for (let count = 0; count < 96; count++) {
        await requireInstalledOperation(installed, command);
        state = await step(command);
        transitions.push({ phase: state.phase, generation: state.generation ?? null, compositionDigest: state.compositionDigest });
        sessionMeasurements = measurements();
        if (state.phase === 'complete' || state.waiting) return state;
        check(Number.isSafeInteger(state.generation) && (previousGeneration === null || state.generation > previousGeneration), 'Controller transition made no durable progress');
        previousGeneration = state.generation; command = 'advance';
      }
      return { ...state, waiting: 'bounded-transition-limit' };
    }) }, boundaries);
  return { ...result, transitions, sessionMeasurements };
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
