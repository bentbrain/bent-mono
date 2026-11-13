import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixtures.mjs';
import { simulator } from './provider-fixtures.mjs';
import { cli } from './cli.mjs';
import { readHead } from '../journal.mjs';
import { canonical, check, digest } from '../data.mjs';

const { values } = parseArgs({ strict: true, options: { output: { type: 'string' }, bundle: { type: 'string' }, manifest: { type: 'string' }, trust: { type: 'string' }, provider: { type: 'string' } } });
check(values.output, 'Provide a new private --output directory');
const startedAt = Date.now(), output = resolve(values.output);
check(!`${output}/`.startsWith(fileURLToPath(new URL('../../../../../', import.meta.url))), 'Keep private proof output outside the source checkout');
await mkdir(output, { mode: 0o700 });
const provided = [values.bundle, values.manifest, values.trust, values.provider];
check(provided.every(Boolean) || provided.every(value => !value), 'Supply bundle, manifest, trust and provider together');
let provider, configuration, failure = null;
const invocations = [];
try {
  if (values.bundle) {
    configuration = { directory: output, bundle: resolve(values.bundle), manifest: resolve(values.manifest), trustPath: resolve(values.trust), journal: join(output, 'journal') };
    provider = { origin: values.provider, close: async () => {} };
  } else {
    configuration = await fixture({ root: output });
    provider = await simulator();
  }
  for (let count = 0; count < 100; count++) {
    const result = await cli(configuration, provider.origin);
    invocations.push(result);
    if (result.code !== 0) { failure = 'actual-cli-failed'; break; }
    const resultValue = JSON.parse(result.stdout);
    if (resultValue.waiting) { failure = resultValue.waiting; break; }
    if (resultValue.phase === 'complete') break;
  }
  const state = (await readHead(configuration.journal))?.state;
  if (state?.phase !== 'complete') failure ??= 'transition-bound-reached';
  const finishedAt = Date.now();
  const summary = { schema: 'shop.actual-cli-http-proof/v1', scope: 'inactive-loopback', fixtureOnly: !values.bundle, startedAt, finishedAt,
    elapsedMs: finishedAt - startedAt, productionDeliveryMeasured: false, complete: state?.phase === 'complete', failure,
    compositionDigest: state?.compositionDigest ?? null, journalGeneration: state?.generation ?? null, journalStateDigest: state ? digest(state) : null,
    invocations: invocations.length, runnerEvidence: state?.verification?.activeJourney ?? null,
    budget: state?.budget ?? null, physicalEffects: provider.state?.physicalEffects ?? null };
  await writeFile(join(output, 'proof-summary.private.json'), canonical(summary), { mode: 0o600 });
  if (provider.state) await writeFile(join(output, 'provider-state.private.json'), canonical(provider.state), { mode: 0o600 });
  await writeFile(join(output, 'executed-invocations.private.json'), canonical(invocations), { mode: 0o600 });
  process.stdout.write(`${canonical(summary)}\n`);
  if (failure) process.exitCode = 1;
} catch (error) {
  await writeFile(join(output, 'proof-failure.private.json'), canonical({ schema: 'shop.local-proof-failure/v1', message: error.message, startedAt, finishedAt: Date.now() }), { mode: 0o600 });
  throw error;
} finally { if (provider) await provider.close(); }
