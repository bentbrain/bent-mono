// Local CPU experiment only. No credentials, network, queue or remote storage.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderPrint } from './render.mjs';
import { renderPrint as renderReference } from './testing/png-layer-reference.mjs';

const [cameraPath, croppedPath, reportPath] = process.argv.slice(2);
assert.ok(cameraPath && croppedPath && reportPath, 'Usage: node benchmark-render.mjs CAMERA_SOURCE CROPPED_SOURCE REPORT_JSON');
const fixtures = JSON.parse(await readFile(new URL('./plans.json', import.meta.url), 'utf8'));
const paths = { camera: cameraPath, cropped: croppedPath };
const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const results = [];
for (const fixture of fixtures) {
  const source = await readFile(paths[fixture.name]);
  assert.equal(source.length, fixture.bytes);
  assert.equal(createHash('sha256').update(source).digest('hex'), fixture.sha256);
  // Check full-resolution pixels, including alpha, before considering speed.
  for (const plan of fixture.plans) {
    const reference = await renderReference(source, plan);
    const candidate = await renderPrint(source, plan);
    const candidatePixels = await sharp(candidate).ensureAlpha().raw().toBuffer();
    const referencePixels = await sharp(reference).ensureAlpha().raw().toBuffer();
    assert.ok(candidatePixels.equals(referencePixels), `${fixture.name} ${plan.width}x${plan.height} differs from the reference`);
  }
  const measurements = { reference: [], candidate: [] };
  for (let iteration = 0; iteration < 4; iteration++) {
    const order = iteration % 2 === 0 ? ['reference', 'candidate'] : ['candidate', 'reference'];
    for (const name of order) {
      const renderer = name === 'reference' ? renderReference : renderPrint;
      const started = performance.now();
      await Promise.all(fixture.plans.map(plan => renderer(source, plan)));
      measurements[name].push(performance.now() - started);
    }
  }
  const referenceMedianMs = median(measurements.reference), candidateMedianMs = median(measurements.candidate);
  results.push({ fixture: fixture.name, sourceSha256: fixture.sha256, pixelEquality: true,
    geometryCount: fixture.plans.length, measurements, referenceMedianMs, candidateMedianMs,
    reductionPercent: 100 * (1 - candidateMedianMs / referenceMedianMs) });
  console.info(JSON.stringify(results.at(-1)));
}
await writeFile(reportPath, JSON.stringify({ runtime: process.version, platform: process.platform,
  architecture: process.arch, sharp: sharp.versions.sharp, libvips: sharp.versions.vips,
  sharpConcurrency: sharp.concurrency(), scope: 'Local render only, three simultaneous shirt geometries; source already loaded; no queue, S3, R2, tote or browser timing.',
  results }, null, 2) + '\n');
