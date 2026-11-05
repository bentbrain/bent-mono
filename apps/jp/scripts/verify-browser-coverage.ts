import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { browserCoverage, caseKey } from '../tests/fixtures/browser-coverage';

const specSchema = z.object({
  id: z.string(),
  title: z.string(),
  file: z.string(),
  tests: z
    .array(
      z.object({
        expectedStatus: z.literal('passed'),
        annotations: z.array(z.object({ type: z.string() })),
      }),
    )
    .min(1),
});
type Collected = { id: string; key: string };
function walk(value: unknown, parents: string[] = []): Collected[] {
  const suite = z
    .object({
      title: z.string(),
      specs: z.array(z.unknown()).default([]),
      suites: z.array(z.unknown()).default([]),
    })
    .parse(value);
  const titles = [...parents, suite.title];
  return [
    ...suite.specs.map((value) => {
      const spec = specSchema.parse(value);
      assert.ok(
        spec.tests.every((test) =>
          test.annotations.every(
            (a) => !['skip', 'fixme', 'fail'].includes(a.type),
          ),
        ),
        `Unexpected annotation: ${spec.title}`,
      );
      return { id: spec.id, key: caseKey(spec.file, [...titles, spec.title]) };
    }),
    ...suite.suites.flatMap((child) => walk(child, titles)),
  ];
}
async function collect(tier: string) {
  const child = spawn(
    'bun',
    ['x', 'playwright', 'test', '--list', '--reporter=json'],
    {
      env: { ...process.env, E2E_TIER: tier },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Collection failed for ${tier}`));
    });
  });
  const report = z
    .object({ suites: z.array(z.unknown()), errors: z.array(z.unknown()) })
    .parse(JSON.parse(output));
  assert.equal(report.errors.length, 0);
  const cases = report.suites.flatMap((suite) => walk(suite));
  assert.ok(cases.length > 0, `${tier} collected zero tests`);
  assert.equal(
    new Set(cases.map((item) => item.key)).size,
    cases.length,
    `${tier} has duplicate cases`,
  );
  return cases;
}

const originals = browserCoverage.cases;
assert.equal(new Set(originals.map((entry) => entry.caseId)).size, 333);
const expectedFull = [...originals, ...browserCoverage.additionalCases];
assert.equal(
  new Set(expectedFull.map((entry) => caseKey(entry.file, entry.titlePath)))
    .size,
  expectedFull.length,
);
for (const entry of originals) {
  assert.ok(
    entry.perPrBrowser ||
      entry.perPrContracts.length ||
      entry.representatives.length,
    `No per-PR risk coverage for ${entry.caseId}`,
  );
  for (const id of entry.representatives)
    assert.ok(
      originals.find((candidate) => candidate.caseId === id)?.perPrBrowser,
      `Representative ${id} is not per-PR`,
    );
  for (const contract of entry.perPrContracts) {
    assert.match(
      contract.file,
      /^(tests\/[^/]+\.test\.ts|scripts\/integration-browser-contracts\.ts)$/,
    );
    const source = await readFile(contract.file, 'utf8');
    assert.ok(
      source.includes(contract.test),
      `Contract declaration missing: ${contract.file} ${contract.test}`,
    );
  }
}
const full = await collect('full');
const critical = await collect('critical');
assert.deepEqual(
  new Set(full.map((entry) => entry.key)),
  new Set(expectedFull.map((entry) => caseKey(entry.file, entry.titlePath))),
  'Full browser collection differs from the explicit coverage manifest',
);
for (const entry of originals) {
  const native = full.find(
    (item) => item.key === caseKey(entry.file, entry.titlePath),
  );
  assert.equal(
    native?.id,
    entry.caseId,
    `Canonical ID changed: ${entry.caseId}`,
  );
}
assert.deepEqual(
  new Set(critical.map((entry) => entry.key)),
  new Set(
    expectedFull
      .filter((entry) => entry.perPrBrowser)
      .map((entry) => caseKey(entry.file, entry.titlePath)),
  ),
  'Default browser CLI differs from the explicit per-PR manifest',
);
const directory = resolve(
  process.env.BROWSER_METRICS_DIR || 'artifacts/browser/coverage',
);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(
  resolve(directory, 'coverage.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      originalCaseCount: 333,
      fullCaseCount: full.length,
      criticalCaseCount: critical.length,
      originalCanonicalIdsVerified: true,
      cases: originals.map((entry) => ({
        caseId: entry.caseId,
        perPrBrowser: entry.perPrBrowser,
        perPrContracts: entry.perPrContracts,
        fullBrowser: entry.fullBrowser,
        representatives: entry.representatives,
      })),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Browser coverage verified: all 333 original canonical IDs; ${String(critical.length)} per-PR and ${String(full.length)} full browser cases; no skipped declarations.`,
);
