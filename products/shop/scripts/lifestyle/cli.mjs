import { resolveProtectedTemplate } from "../protected-config.mjs";
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { renderLifestyle } from './render.mjs';
import { loadLifestyleTemplate } from '../../workers/video-renderer/src/lifestyle-template.mjs';
import { reviewHtml } from './review.mjs';
const { values } = parseArgs({ options: { templates: { type: 'string', default: 'assets/lifestyle/featured.json' },
        samples: { type: 'string', default: '.data/lifestyle/preview/samples.json' }, artwork: { type: 'string' },
        out: { type: 'string', default: '.data/lifestyle/review' } } });
const manifest = JSON.parse(resolveProtectedTemplate(await readFile(values.templates, 'utf8')));
if (manifest.version !== 1 || !Array.isArray(manifest.templates) || manifest.templates.length !== 2)
    throw new Error('A version 1 template manifest with black and white templates is required.');
if (new Set(manifest.templates.map(item => item.id)).size !== 2 || !manifest.templates.every(item => ['black', 'white'].includes(item.id)))
    throw new Error('Black and white template IDs are required.');
const source = values.artwork ? { samples: [{ id: 'design-1', label: 'Your design', artwork: resolve(values.artwork) }] } : JSON.parse(resolveProtectedTemplate(await readFile(values.samples, 'utf8')));
if (!Array.isArray(source.samples) || source.samples.length === 0)
    throw new Error('At least one artwork sample is required.');
const output = resolve(values.out), templateRoot = dirname(resolve(values.templates));
await mkdir(output, { recursive: true });
const hashes = [], renders = [], reviewTemplates = [];
for (const template of manifest.templates) {
    const input = await loadLifestyleTemplate(manifest, template.id, file => readFile(resolve(templateRoot, file)));
    for (const key of ['base', 'lighting', 'mask', 'displacementMap'])
        if (template[key]) {
            input[key] = await readFile(resolve(templateRoot, template[key]));
            hashes.push({ template: template.id, role: key, sha256: createHash('sha256').update(input[key]).digest('hex') });
        }
    const blank = await sharp(input.base).rotate().png().toBuffer({ resolveWithObject: true });
    reviewTemplates.push({ ...template, width: blank.info.width, height: blank.info.height });
    await writeFile(resolve(output, `base-${template.id}.png`), blank.data);
    for (const sample of source.samples) {
        if (!/^[a-z0-9-]{1,80}$/.test(sample.id))
            throw new Error('Invalid sample ID.');
        const artwork = await readFile(resolve(dirname(resolve(values.samples)), sample.artwork));
        const start = performance.now();
        const result = await renderLifestyle({ ...input, artwork });
        const file = `${sample.id}-${template.id}.png`;
        await writeFile(resolve(output, file), result.image);
        const xs = template.quad.map(point => point[0] * result.width), ys = template.quad.map(point => point[1] * result.height);
        const margin = Math.round(result.width * .025);
        const left = Math.max(0, Math.floor(Math.min(...xs)) - margin), top = Math.max(0, Math.floor(Math.min(...ys)) - margin);
        const right = Math.min(result.width, Math.ceil(Math.max(...xs)) + margin), bottom = Math.min(result.height, Math.ceil(Math.max(...ys)) + margin);
        await sharp(result.image).extract({ left, top, width: right - left, height: bottom - top }).png()
            .toFile(resolve(output, `${sample.id}-${template.id}-detail.png`));
        await writeFile(resolve(output, `${sample.id}-artwork.png`), artwork);
        await writeFile(resolve(output, `folds-${template.id}.png`), result.displacement);
        await writeFile(resolve(output, `${sample.id}-${template.id}-shadows.png`), result.shadows);
        await writeFile(resolve(output, `${sample.id}-${template.id}-highlights.png`), result.highlights);
        const elapsedMs = Math.round(performance.now() - start);
        renders.push({ file, width: result.width, height: result.height, elapsedMs,
            artworkSha256: createHash('sha256').update(artwork).digest('hex'), sha256: createHash('sha256').update(result.image).digest('hex') });
        console.log(`${file}: ${result.width} × ${result.height}, ${elapsedMs} ms`);
    }
}
await writeFile(resolve(output, 'render-manifest.json'), JSON.stringify({ renderedAt: new Date().toISOString(), source, templates: manifest, hashes, renders }, null, 2) + '\n');
await writeFile(resolve(output, 'index.html'), reviewHtml(source.samples, reviewTemplates));
console.log(`Review saved to ${output}/index.html`);
