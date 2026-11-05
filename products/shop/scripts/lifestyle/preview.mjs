import { protectedConfig } from "../protected-config.mjs";
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { planCroppedSource, planRecursiveLayers } from '../../workers/api/src/print-assets.ts';
import { renderPrint } from '../../workers/print-benchmark/runtime/render.mjs';
import { PRODUCT_MOCKUP_GEOMETRY } from '../../packages/contracts/src/product-mockup-geometry.js';
// Existing Preview sample products, originally recorded in the featured-products receipt.
// Every invocation checks their current records and readiness before reading artwork.
const defaults = ["d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4", protectedConfig("resource_60ac4424fdf7"), protectedConfig("resource_400df0568747")];
const { values } = parseArgs({ options: { environment: { type: 'string', default: 'preview' }, out: { type: 'string' }, product: { type: 'string', multiple: true } } });
if (!['preview', 'production'].includes(values.environment))
    throw new Error('Choose preview or production.');
if (values.environment === 'production' && !values.product?.length)
    throw new Error('Production reads require explicit --product IDs.');
const environment = values.environment === 'production' ? 'Production' : 'Preview';
const origin = values.environment === 'production' ? 'https://forever-tee-api.socialqueue.workers.dev' : 'https://forever-tee-api-development.socialqueue.workers.dev';
const directory = resolve(values.out ?? `.data/lifestyle/${values.environment}`);
await mkdir(directory, { recursive: true });
async function get(path) {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok)
        throw new Error(`${environment} read failed (${response.status}): ${path}`);
    return response;
}
const samples = [];
for (const productId of values.product ?? defaults) {
    if (!/^[a-f0-9-]{36}$/.test(productId))
        throw new Error('A product UUID is required.');
    const product = await (await get(`/v1/products/${productId}`)).json();
    if (product.baseProductId !== "a51b7acf-77e9-4762-83c4-62d96dd8942c" || !product.designId || !product.placement)
        throw new Error('A configured shirt product is required.');
    const design = await (await get(`/v1/designs/${product.designId}`)).json();
    if (design.status !== 'ready' || !/^[a-f0-9]{64}$/.test(design.artworkRevision))
        throw new Error('Design artwork is not ready.');
    // Match the storefront's ready-design lookup, snapshotting its current artwork
    // and verifying the full source hash instead of relying on the preview URL query.
    const artworkPath = `/v1/designs/${design.id}/artwork`;
    const source = Buffer.from(await (await get(artworkPath)).arrayBuffer());
    if (createHash('sha256').update(source).digest('hex') !== design.artworkRevision)
        throw new Error('Artwork differs from the advertised design revision.');
    const current = await (await get(`/v1/designs/${design.id}`)).json();
    if (JSON.stringify(current) !== JSON.stringify(design))
        throw new Error('Design changed during download; retry with its current revision.');
    const currentProduct = await (await get(`/v1/products/${productId}`)).json();
    if (JSON.stringify(currentProduct) !== JSON.stringify(product))
        throw new Error('Product changed during download; retry with its current placement.');
    const metadata = await sharp(source).metadata();
    const physical = PRODUCT_MOCKUP_GEOMETRY['staple-tee'].canvas;
    const geometry = { width: 1000, height: Math.round(1000 * physical.heightPx / physical.widthPx) };
    const settings = { ...design.settings, placementX: product.placement.x, placementY: product.placement.y,
        placementWidth: product.placement.width, depth: product.placement.depth, printMode: product.printMode ?? 'recursive' };
    if (!Number.isInteger(settings.depth) || settings.depth < 0 || settings.depth > 10 ||
        ![settings.placementX, settings.placementY, settings.placementWidth].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
        throw new Error('Invalid product placement.');
    const layers = planRecursiveLayers(planCroppedSource(metadata.width, metadata.height, geometry, settings), geometry, settings);
    const artwork = await renderPrint(source, { ...geometry, layers });
    const id = `design-${samples.length + 1}`;
    await writeFile(resolve(directory, `${id}-source.png`), source);
    await writeFile(resolve(directory, `${id}-artwork.png`), artwork);
    samples.push({ id, label: `${environment} design ${samples.length + 1}`, productId, designId: design.id,
        ...(environment === 'Production' ? { productUrl: `https://shop.bent.build/featured/${productId}` } : {}),
        productRevisionId: product.designRevisionId, artworkRevision: design.artworkRevision, sourceUrl: new URL(artworkPath, origin).href,
        sourceSha256: createHash('sha256').update(source).digest('hex'), settings,
        artwork: `${id}-artwork.png`, source: `${id}-source.png` });
    console.log(`Read ${productId}; composed ${id} at ${geometry.width} × ${geometry.height}.`);
}
await writeFile(resolve(directory, 'samples.json'), JSON.stringify({ environment, origin, fetchedAt: new Date().toISOString(), samples }, null, 2) + '\n');
console.log(`Saved local ${environment} inputs to ${directory}`);
