import { resolveProtectedTemplate } from "../protected-config.mjs";
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { renderLifestyle } from './render.mjs';
import { loadLifestyleTemplate } from '../../workers/video-renderer/src/lifestyle-template.mjs';
import { PRODUCT_MOCKUP_GEOMETRY } from '../../workers/video-renderer/src/product-mockup-geometry.mjs';
const { values } = parseArgs({ options: { templates: { type: 'string', default: 'assets/lifestyle/featured.json' },
        out: { type: 'string', default: '.data/lifestyle/calibration' } } });
const manifest = JSON.parse(resolveProtectedTemplate(await readFile(values.templates, 'utf8')));
const output = resolve(values.out), root = dirname(resolve(values.templates));
await mkdir(output, { recursive: true });
const canvas = PRODUCT_MOCKUP_GEOMETRY['staple-tee'].canvas;
const width = 1000, height = Math.round(width * canvas.heightPx / canvas.widthPx);
// A code-generated measuring graphic, sent directly through the real compositor.
// The border marks 100% of the configured print canvas, with no portrait crop.
const cells = [];
for (let row = 0; row < 12; row++)
    for (let column = 0; column < 10; column++) {
        const x = column * width / 10, y = row * height / 12, w = width / 10, h = height / 12;
        cells.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${(row + column) % 2 ? '#ffffff' : '#176cff'}" fill-opacity=".12"/>
    <text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" stroke="#0a1733" stroke-width="2" paint-order="stroke" font-family="sans-serif" font-weight="bold" font-size="25">${String.fromCharCode(65 + column)}${row + 1}</text>`);
    }
const lines = [];
for (let i = 0; i <= 10; i++)
    lines.push(`<path d="M${i * width / 10} 0V${height}"/>`);
for (let i = 0; i <= 12; i++)
    lines.push(`<path d="M0 ${i * height / 12}H${width}"/>`);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${cells.join('')}
  <g fill="none" stroke="#102338" stroke-width="9">${lines.join('')}</g>
  <g fill="none" stroke="#00efff" stroke-width="5">${lines.join('')}</g>
  <path d="M500 0V${height}M0 ${height / 2}H1000" fill="none" stroke="#ff34d0" stroke-width="8"/>
  <rect x="5" y="5" width="990" height="${height - 10}" fill="none" stroke="#ff7b00" stroke-width="10"/></svg>`;
const artwork = await sharp(Buffer.from(svg)).png().toBuffer();
await writeFile(resolve(output, 'grid.png'), artwork);
const variants = [
    { id: 'unmasked', label: 'Without garment mask', description: 'Current print area and displacement, without clipping to visible fabric.' },
    { id: 'masked', label: 'With garment mask', description: 'Identical print area and displacement. Ink is clipped to visible shirt fabric after warping.' },
];
const records = [];
for (const template of manifest.templates) {
    const inputs = await loadLifestyleTemplate(manifest, template.id, file => readFile(resolve(root, file)));
    for (const key of ['base', 'lighting', 'mask', 'displacementMap'])
        if (template[key])
            inputs[key] = await readFile(resolve(root, template[key]));
    if (!inputs.mask)
        throw new Error('A garment mask is required for calibration.');
    await sharp(inputs.mask).png().toFile(resolve(output, `${template.id}-mask.png`));
    for (const variant of variants) {
        const settings = { ...template };
        const input = { ...settings, ...inputs, artwork };
        if (variant.id === 'unmasked')
            delete input.mask;
        const result = await renderLifestyle(input);
        const name = `${template.id}-${variant.id}`;
        await writeFile(resolve(output, `${name}.png`), result.image);
        const xs = settings.quad.map(([x]) => x * result.width), ys = settings.quad.map(([, y]) => y * result.height);
        const margin = Math.round(result.width * .06);
        const left = Math.max(0, Math.floor(Math.min(...xs)) - margin), top = Math.max(0, Math.floor(Math.min(...ys)) - margin);
        const right = Math.min(result.width, Math.ceil(Math.max(...xs)) + margin), bottom = Math.min(result.height, Math.ceil(Math.max(...ys)) + margin);
        await sharp(result.image).extract({ left, top, width: right - left, height: bottom - top }).flatten({ background: '#f5f5f5' }).png().toFile(resolve(output, `${name}-detail.png`));
        if (variant.id === 'masked') {
            await writeFile(resolve(output, `${template.id}-displacement.png`), result.displacement);
            await writeFile(resolve(output, `${template.id}-shadows.png`), result.shadows);
        }
        records.push({ colour: template.id, variant: variant.id, quad: settings.quad, displacement: settings.displacement });
    }
}
await writeFile(resolve(output, 'calibration.json'), JSON.stringify({ canvas: { width, height }, records }, null, 2) + '\n');
await writeFile(resolve(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Displacement calibration</title>
<style>*{box-sizing:border-box}body{margin:0;padding:28px;background:#f5f5f5;color:#142033;font:15px/1.5 system-ui,sans-serif}main{max-width:1900px;margin:auto}h1{margin:0}p{max-width:980px}a{color:#1646c7}section{margin-top:36px}.row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0}img{width:100%;display:block;background:white}h3{margin:0 0 8px}figcaption{padding:12px 0;font-size:13px}summary{cursor:pointer;padding:14px 0}.full img{max-width:400px}.grid{max-width:240px}a:focus-visible,summary:focus-visible{outline:3px solid #1646c7}@media(max-width:900px){.row{grid-template-columns:repeat(2,minmax(0,1fr))}body{padding:16px}}</style>
<main><h1>Displacement calibration</h1><p>A numbered 10 × 12 grid covering the entire configured print canvas. Orange = boundary, cyan = grid, magenta = centre axes. Rendered through the application compositor.</p><p>Compare the same cell across columns. Look at G–J along the right edge and rows 7–12 over the lower folds. Both columns use the same full print area and current displacement. Only the garment mask changes. Preview is unchanged.</p>
${manifest.templates.map(t => `<section><h2>${t.id} shirt</h2><div class="row">${variants.map(v => `<figure><h3>${v.label}</h3><a href="${t.id}-${v.id}.png"><img src="${t.id}-${v.id}-detail.png" alt="${t.id} shirt grid: ${v.label}"></a><figcaption>${v.description}<br><a href="${t.id}-${v.id}.png">Full photograph</a></figcaption></figure>`).join('')}</div><details><summary>Masked full photograph and diagnostic maps</summary><div class="row full"><img src="${t.id}-masked.png" alt="Full ${t.id} calibration"><a href="${t.id}-mask.png">Visible-shirt mask</a><a href="${t.id}-displacement.png">Displacement map</a><a href="${t.id}-shadows.png">Shadow map</a></div></details></section>`).join('')}
<details><summary>Original grid and exact settings</summary><a href="grid.png"><img class="grid" src="grid.png" alt="Undistorted source grid"></a><a href="calibration.json">Calibration parameters</a></details></main></html>`);
console.log(`Calibration written to ${output}`);
