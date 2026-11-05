import { readFile, writeFile } from 'node:fs/promises';
import { planCroppedSource, planRecursiveLayers } from '../api/src/print-assets.ts';
import { validateInvocation } from './runtime/contract.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url), 'utf8'));
const planned = fixtures.map(fixture => ({ ...fixture, plans: fixture.geometries.map(geometry => ({
  width: geometry.width, height: geometry.height,
  layers: planRecursiveLayers(planCroppedSource(fixture.sourceWidth, fixture.sourceHeight, geometry, fixture.settings), geometry, fixture.settings),
})) }));
for (const fixture of planned) validateInvocation({ fixture: fixture.name, runId: '1', invocation: 'a'.repeat(32) }, planned);
await writeFile(new URL('./runtime/plans.json', import.meta.url), JSON.stringify(planned, null, 2) + '\n');
console.info('Prepared bounded pixel plans using the application renderer geometry.');
