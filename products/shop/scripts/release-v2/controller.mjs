import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, digest, same, canonical } from './data.mjs';
import { admit, compatible } from './composition.mjs';
import { withWriter, recoverWriter, readHead, recordFailure } from './journal.mjs';
import { client, fixtureEnvironment, loopbackOrigin } from './provider.mjs';
import { journey } from './journey.mjs';
import { stageRequest, verifyContent } from './artifact-transport.mjs';
import { selectedVersion } from './component-identity.mjs';

const wanted = selectedVersion;
const ordered = states => [...states].sort((a, b) => a.component < b.component ? -1 : a.component > b.component ? 1 : 0);
const exact = (states, expected) => check(same(ordered(states), ordered(expected)), 'Observed active component composition differs');
const checkpoint = (point, crashAt) => { if (point === crashAt) process.exit(86); };
const faults = new Set(['before-event', 'after-event', 'before-head', 'after-head', 'before-post', 'after-post']);
const processStartedAt = Math.floor(Date.now() - process.uptime() * 1000);

export async function advance(options) {
  fixtureEnvironment(process.env);
  const { directory, origin } = options;
  loopbackOrigin(origin);
  return advanceWithPorts(options, {
    admit,
    withWriter: work => withWriter(directory, work),
    readHead: () => readHead(directory),
    provider: client(origin),
    journey,
    context: { id: origin, scope: 'inactive-local', stateSchema: 'shop.local-release/v1',
      verificationSchema: 'shop.local-verification/v1', budgetScope: 'inactive-local-controller',
      startedAt: processStartedAt, verificationEvent: false }
  });
}

// Admission and credential custody belong to the caller's protected boundary.
// The transition engine receives the same ports in fixture and hosted callers.
export async function advanceWithPorts(options, ports) {
  const { bundle, directory, origin, command = 'advance', crashAt } = options;
  const { context, provider } = ports;
  const prepareStage = ports.stageRequest ?? stageRequest;
  const verifyObservedContent = ports.verifyContent ?? verifyContent;
  check(typeof verifyObservedContent === 'function', 'Complete content verification port required');
  check(typeof prepareStage === 'function', 'Exact artifact transport port required');
  check(context && ['inactive-local', 'isolated-qualification'].includes(context.scope) &&
    typeof context.id === 'string' && context.id.length > 0 && context.id.length <= 512 &&
    Number.isSafeInteger(context.startedAt) && context.startedAt > 0 && context.startedAt <= Date.now(), 'Exact controller context required');
  check(context.stateSchema === (context.scope === 'inactive-local' ? 'shop.local-release/v1' : 'shop.hosted-release/v1') &&
    context.verificationSchema === (context.scope === 'inactive-local' ? 'shop.local-verification/v1' : 'shop.hosted-verification/v1') &&
    context.verificationEvent === (context.scope === 'isolated-qualification'), 'Controller journal domain differs');
  for (const name of ['admit', 'withWriter', 'readHead', 'journey']) check(typeof ports[name] === 'function', `Controller port missing: ${name}`);
  for (const name of ['inventory', 'content', 'runtime', 'operations', 'write', 'reports']) check(typeof provider?.[name] === 'function', `Provider port missing: ${name}`);
  if (context.verificationEvent) check(typeof ports.verificationRef === 'function', 'Immutable runtime verification reference required');
  check(['advance', 'begin', 'rollback', 'recover-report'].includes(command), 'Unknown controller operation');
  if (crashAt) check(/^[a-z-]+:[a-z-]+$/.test(crashAt) && faults.has(crashAt.split(':')[1]), 'Unknown fixture crash boundary');
  check(!crashAt || context.scope === 'inactive-local', 'Crash injection is restricted to the fixture caller');
  return ports.withWriter(async ({ initial, commit, assertOwner }) => {
    const admission = await ports.admit(options);
    const { payload, compositionDigest, trust } = admission;
    check(trust.scope === (context.scope === 'inactive-local' ? 'inactive-loopback' : 'isolated-qualification'), 'Admission and journal trust domains differ');
    const persist = async state => {
      state.elapsedMs = Date.now() - state.startedAt;
      state.budget = { scope: context.budgetScope, limitMs: trust.budgetMs, elapsedMs: state.elapsedMs, exceeded: state.elapsedMs >= trust.budgetMs,
        productionDeliveryMeasured: false };
      return commit(state, point => checkpoint(`${state.phase}:${point}`, crashAt));
    };
    const initialise = async (previous = null) => {
      const observed = await provider.inventory();
      exact(observed.active, previous?.lastVerified?.components.map(wanted) ?? []);
      const order = compatible(payload, previous?.lastVerified ?? null, observed);
      if (previous) {
        check(previous.phase === 'complete' && previous.operation === null, 'Previous release has unresolved work');
        if (command === 'rollback') {
          check(previous.history.some(item => digest(item) === compositionDigest), 'Rollback requires a previously verified composition');
          check(previous.desired.rollbackCompositionDigest === compositionDigest && payload.schemaState.rollbackEpochs.includes(previous.lastVerified.schemaState.epoch), 'Rollback target or schema constraint differs');
        } else check(payload.parentCompositionDigest === digest(previous.lastVerified), 'Parent composition differs');
        for (const component of previous.lastVerified.components) verifyObservedContent(await provider.content(component.id, wanted(component).version), component);
      } else check(command !== 'rollback' && payload.parentCompositionDigest === null, 'Initial composition requires an empty verified history');
      const staged = payload.components.map(wanted).filter(candidate => observed.versions.some(version => same(version, candidate)));
      for (const candidate of staged) {
        const component = payload.components.find(item => item.id === candidate.component);
        verifyObservedContent(await provider.content(candidate.component, candidate.version), component);
      }
      return persist({ schema: context.stateSchema, generation: 0, id: randomUUID(), compositionDigest, desired: payload, observed: observed.active, observedAt: Date.now(),
        lastVerified: previous?.lastVerified ?? null, history: previous?.history ?? [], phase: 'prepared', staged, order, operation: null,
        startedAt: context.startedAt, candidateJourney: null, verification: null, report: null, providerOrigin: context.id, policyDigest: payload.policyDigest });
    };
    if (!initial) {
      check(command !== 'recover-report', 'No pending report');
      return initialise();
    }
    check(initial.schema === context.stateSchema && initial.providerOrigin === context.id && initial.policyDigest === payload.policyDigest, 'Journal authority differs');
    if (command === 'begin' || command === 'rollback') return initialise(initial);
    check(initial.compositionDigest === compositionDigest && same(initial.desired, payload), 'Desired composition differs from durable journal');
    const state = structuredClone(initial);
    check(state.phase !== 'complete' || state.lastVerified && digest(state.lastVerified) === compositionDigest && state.report?.status === 'confirmed', 'Invalid complete state');
    if (state.phase === 'complete') return state;
    if (state.phase === 'runtime-verified') {
      check(context.verificationEvent && state.verification && state.lastVerified && digest(state.lastVerified) === compositionDigest &&
        state.report?.verificationDigest === digest(state.verification), 'Immutable runtime verification subject differs');
      const eventDigest = await ports.verificationRef();
      check(typeof eventDigest === 'string' && /^[a-f0-9]{64}$/.test(eventDigest), 'Immutable runtime verification event required');
      state.report.eventDigest = eventDigest;
      state.report.compositionDigest = compositionDigest;
      state.phase = 'reporting-pending';
      return persist(state);
    }
    const reporting = state.phase.startsWith('report');
    check(command !== 'recover-report' || reporting, 'Reporting recovery requires a verified pending outbox');
    if (reporting) {
      check(state.verification && state.lastVerified && digest(state.lastVerified) === compositionDigest && state.report?.verificationDigest === digest(state.verification), 'Verified outbox subject differs');
      if (state.phase === 'reporting-pending') {
        state.phase = 'report-intent';
        state.operation = { id: state.report.eventId, kind: 'reports', body: { eventId: state.report.eventId, compositionDigest, verificationDigest: state.report.verificationDigest, status: 'success',
          ...(context.verificationEvent ? { eventDigest: state.report.eventDigest } : {}) } };
        state.operation.bodyDigest = digest(state.operation.body);
        return persist(state);
      }
      if (state.phase === 'report-intent') return send(state);
      if (state.phase === 'report-reconcile') {
        const records = await provider.reports(state.report.eventId);
        if (!records.length) return { ...state, waiting: 'unknown-report-acknowledgement' };
        check(same(records[0], state.operation.body), 'Reported verification differs');
        state.report.status = 'confirmed'; state.operation = null; state.phase = 'complete';
        return persist(state);
      }
      throw Error('Unknown reporting state');
    }
    // Every runtime transition rechecks the complete live inventory and overlap.
    const observed = await provider.inventory();
    compatible(payload, state.lastVerified, observed);
    for (const active of observed.active) {
      const component = [...payload.components, ...(state.lastVerified?.components ?? [])].find(item => same(wanted(item), active));
      check(component, 'Active component has no admitted artifact subject');
      verifyObservedContent(await provider.content(component.id, active.version), component);
    }
    const expected = state.observed;
    if (!state.phase.endsWith('-reconcile')) { exact(observed.active, expected); state.observedAt = Date.now(); }
    if (state.phase === 'prepared' || state.phase === 'staging') {
      const component = payload.components.find(item => !state.staged.some(staged => staged.component === item.id));
      if (component) {
        state.phase = 'stage-intent';
        const before = observed.active.find(item => item.component === component.id)?.version ?? null;
        state.operation = { id: randomUUID(), kind: 'stage', body: { id: '', ...wanted(component), expectedActiveVersion: before,
          artifact: component.artifact, config: component.config, provenance: component.provenance } };
        state.operation.body.id = state.operation.id; state.operation.bodyDigest = digest(await prepareStage(bundle, state.operation.body));
      } else {
        exact(state.staged, payload.components.map(wanted));
        for (const staged of state.staged) check(observed.versions.some(item => same(item, staged)), 'Staged immutable version is missing');
        for (const component of payload.components) verifyObservedContent(await provider.content(component.id, wanted(component).version), component);
        state.candidateJourney = await ports.journey({ bundle, directory, admission, origin, phase: 'candidate' });
        state.phase = 'staged-verified';
      }
      return persist(state);
    }
    if (state.phase === 'stage-intent' || state.phase === 'activate-intent') return send(state);
    if (state.phase === 'stage-reconcile' || state.phase === 'activate-reconcile') {
      const records = await provider.operations(state.operation.id);
      if (!records.length) return { ...state, waiting: 'unknown-provider-acknowledgement' };
      const record = records[0];
      check(record.kind === state.operation.kind && record.bodyDigest === state.operation.bodyDigest, 'Operation body differs');
      const component = payload.components.find(item => item.id === state.operation.body.component);
      check(component && same(record.result, wanted(component)), 'Operation result differs from exact desired artifact');
      check(observed.versions.some(item => same(item, record.result)), 'Version inventory does not contain acknowledged version');
      verifyObservedContent(await provider.content(component.id, record.result.version), component);
      if (record.kind === 'stage') {
        exact(observed.active, expected);
        state.staged.push(record.result); state.phase = 'staging';
      } else {
        const next = state.observed.filter(item => item.component !== component.id).concat(record.result);
        if (!same(ordered(observed.active), ordered(next))) return { ...state, waiting: 'activation-readback-pending' };
        const runtime = await provider.runtime(); exact(runtime, next);
        state.observed = next; state.observedAt = Date.now(); state.phase = 'activating';
      }
      state.operation = null;
      return persist(state);
    }
    if (state.phase === 'staged-verified' || state.phase === 'activating') {
      check(state.candidateJourney?.compositionDigest === compositionDigest && state.candidateJourney.exitCode === 0, 'Candidate journey qualification missing');
      const component = state.order.map(id => payload.components.find(item => item.id === id)).find(item => !observed.active.some(active => same(active, wanted(item))));
      if (component) {
        check(state.staged.some(item => same(item, wanted(component))), 'Candidate was not staged');
        state.phase = 'activate-intent';
        state.operation = { id: randomUUID(), kind: 'activate', body: { id: '', ...wanted(component), expectedActiveVersion: observed.active.find(item => item.component === component.id)?.version ?? null } };
        state.operation.body.id = state.operation.id; state.operation.bodyDigest = digest(state.operation.body);
        return persist(state);
      }
      exact(await provider.runtime(), payload.components.map(wanted));
      for (const component of payload.components) verifyObservedContent(await provider.content(component.id, wanted(component).version), component);
      const smoke = await ports.journey({ bundle, directory, admission, origin, phase: 'active' });
      const finalInventory = await provider.inventory(); exact(finalInventory.active, payload.components.map(wanted));
      exact(await provider.runtime(), payload.components.map(wanted));
      state.observed = finalInventory.active; state.observedAt = Date.now();
      state.verification = { schema: context.verificationSchema, scope: context.scope, compositionDigest, observed: finalInventory.active,
        candidateJourneyDigest: digest(state.candidateJourney), activeJourney: smoke, verifiedAt: Date.now() };
      state.lastVerified = payload;
      if (!state.history.some(item => digest(item) === compositionDigest)) state.history.push(payload);
      state.report = { eventId: randomUUID(), verificationDigest: digest(state.verification), status: 'pending' };
      state.phase = context.verificationEvent ? 'runtime-verified' : 'reporting-pending';
      return persist(state);
    }
    throw Error('Unknown runtime journal state');

    async function send(next) {
      check(next.operation, 'Saved mutation intent missing');
      const kind = next.operation.kind;
      const request = kind === 'stage' ? await prepareStage(bundle, next.operation.body) : next.operation.body;
      check(next.operation.bodyDigest === digest(request), 'Saved mutation intent differs');
      if (kind === 'activate') {
        const component = payload.components.find(item => item.id === next.operation.body.component);
        check(component, 'Unknown activation component');
        verifyObservedContent(await provider.content(component.id, next.operation.body.version), component);
      }
      next.phase = kind === 'reports' ? 'report-reconcile' : `${kind}-reconcile`;
      await persist(next);
      // Intent and uncertain acknowledgement are committed and read back before
      // writing. Any failure from this point leaves a GET-only reconciliation.
      await assertOwner();
      const saved = await ports.readHead();
      check(saved.state.generation === next.generation && same(saved.state.operation, next.operation), 'Saved intent readback differs');
      checkpoint(`${kind}:before-post`, crashAt);
      await provider.write(kind, request);
      checkpoint(`${kind}:after-post`, crashAt);
      return next;
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  fixtureEnvironment(process.env);
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    bundle: { type: 'string' }, manifest: { type: 'string' }, trust: { type: 'string' }, journal: { type: 'string' },
    provider: { type: 'string' }, 'crash-at': { type: 'string' }, 'lock-digest': { type: 'string' }
  } });
  check(positionals.length <= 1 && values.journal, 'Provide one operation and --journal');
  const command = positionals[0] ?? 'advance', directory = resolve(values.journal);
  if (command === 'recover-writer') {
    check(values['lock-digest'] && /^[a-f0-9]{64}$/.test(values['lock-digest']), 'Exact writer compare token required');
    return recoverWriter(directory, values['lock-digest']);
  }
  check(values.bundle && values.manifest && values.trust && values.provider, 'Provide --bundle --manifest --trust --journal --provider');
  return advance({ command, bundle: resolve(values.bundle), manifest: resolve(values.manifest), trustPath: resolve(values.trust), directory,
    origin: values.provider, crashAt: values['crash-at'] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(`${canonical({ phase: result.phase ?? result.state, generation: result.generation ?? null,
    compositionDigest: result.compositionDigest ?? null, waiting: result.waiting ?? null, budget: result.budget ?? null })}\n`))
    .catch(async error => {
      let diagnostic = null;
      try {
        const args = process.argv.slice(2), marker = args.indexOf('--journal');
        const directory = marker >= 0 ? args[marker + 1] : args.find(arg => arg.startsWith('--journal='))?.slice(10);
        if (directory) diagnostic = await recordFailure(resolve(directory), error,
          ['advance', 'begin', 'rollback', 'recover-report', 'recover-writer'].includes(args[0]) ? args[0] : 'cli-admission');
      } catch { /* Invalid or unwritable private destinations remain fail-closed. */ }
      process.stderr.write(`${canonical({ scope: 'inactive-local', code: 'controller-failed', diagnostic,
        diagnosticCapture: diagnostic ? 'verified' : 'unavailable' })}\n`);
      process.exitCode = 1;
    });
}
