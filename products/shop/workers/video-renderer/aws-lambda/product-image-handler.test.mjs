import { protectedConfig } from "./protected-config.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProductImageHandler, validateProductImageJob } from './product-image-handler.mjs';
import { APP_ARN } from './app-handler.mjs';
import { sha256 } from './contract.mjs';
import { loadLifestyleTemplate } from '../src/lifestyle-template.mjs';
const artwork = Buffer.from('source');
const id = '11111111-1111-4111-8111-111111111111';
const job = { kind: 'product-image', schemaVersion: 1, jobId: id, attempt: 1, grant: 'grant.signature', rendererVersion: 'product-images-v4',
    artwork: { sha256: sha256(artwork), size: artwork.length }, baseProductSlug: 'staple-tee', color: 'White', view: 'lifestyle', printMode: 'recursive',
    storageKey: `designs/${id}/product-images/v4/${id}/${id}/white-lifestyle.webp`,
    settings: { cropX: .5, cropY: .5, cropZoom: 1, depth: 5, placementX: .3, placementY: .3, placementWidth: .3 } };
const context = { invokedFunctionArn: APP_ARN, awsRequestId: 'fixture', getRemainingTimeInMillis: () => 120000 };
const image = Buffer.from('RIFF0000WEBPfixture');
function handler(send, render = async () => image) {
    return createProductImageHandler({ apiOrigin: 'https://forever-tee-api-development.socialqueue.workers.dev',
        buildId: 'a'.repeat(64), readAsset: async (file) => file === 'lifestyle.json' ? Buffer.from('{"version":1,"product":{"slug":"staple-tee","geometryVersion":"physical-print-area-v1"},"templates":[{"id":"white","mask":"featured-mask-white.svg"}]}') : Buffer.from('blank'), render, send });
}
test('image deliveries claim before reading and retry a lost upload acknowledgement with the same fence', async () => {
    const calls = [];
    let uploads = 0;
    const result = await handler(async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/claim'))
            return new Response(null, { status: 201 });
        if (url.endsWith('/artwork'))
            return new Response(artwork);
        if (url.endsWith('/image')) {
            if (++uploads === 1)
                throw new Error('lost ack');
            return Response.json({ key: job.storageKey, size: image.length, sha256: sha256(image) });
        }
        throw new Error('unexpected request');
    })(job, context);
    assert.equal(result.sha256, sha256(image));
    assert.equal(uploads, 2);
    assert.equal(result.executionId, calls[0].options.headers["x-image-execution-id"]);
    assert.ok(calls.every(call => call.options.headers['x-image-execution-id'] === calls[0].options.headers['x-image-execution-id']));
});
test('duplicate deliveries and wrong runtime never render or read portraits', async () => {
    let calls = 0;
    const execute = handler(async () => { calls++; return new Response(null, { status: 204 }); }, async () => { throw new Error('rendered duplicate'); });
    assert.equal((await execute(job, context)).status, 'skipped');
    assert.equal(calls, 1);
    await assert.rejects(execute(job, { ...context, invokedFunctionArn: APP_ARN.replace(protectedConfig("awsAccountId"), '111111111111') }));
    assert.equal(calls, 1);
});
test('unverified source bytes cannot reach the renderer', async () => {
    let rendered = false, failed = false;
    await assert.rejects(handler(async (url) => {
        if (url.endsWith('/claim'))
            return new Response(null, { status: 201 });
        if (url.endsWith('/failure')) {
            failed = true;
            return new Response(null, { status: 204 });
        }
        return new Response(Buffer.from('badbad'));
    }, async () => { rendered = true; return image; })(job, context), /checksum/);
    assert.equal(rendered, false);
    assert.equal(failed, true);
});
test('invalid view, colour, source size, placement and keys fail closed', () => {
    for (const update of [{ view: 'anything' }, { color: 'Cream' }, { baseProductSlug: 'cotton-tote' }, { artwork: { sha256: 'a'.repeat(64), size: 26000000 } },
        { storageKey: job.storageKey.replace('white-lifestyle', 'black-flat') }, { settings: { ...job.settings, placementWidth: 2 } }, { rendererVersion: 'unknown' }]) {
        assert.throws(() => validateProductImageJob({ ...job, ...update }));
    }
});
test('template loading requires the product geometry and a real mask before rendering', async () => {
    const manifest = { version: 1, product: { slug: 'staple-tee', geometryVersion: 'physical-print-area-v1' },
        templates: [{ id: 'white', mask: 'featured-mask-white.svg' }] };
    const files = [];
    const template = await loadLifestyleTemplate(manifest, 'white', async (file) => { files.push(file); return Buffer.from('mask'); });
    assert.deepEqual(files, ['featured-mask-white.svg']);
    assert.equal(template.mask.toString(), 'mask');
    for (const invalid of [{ ...manifest, product: { ...manifest.product, geometryVersion: 'other' } },
        { ...manifest, templates: [{ id: 'white' }] },
        { ...manifest, templates: [{ id: 'white', mask: '../outside.svg' }] }]) {
        await assert.rejects(loadLifestyleTemplate(invalid, 'white', async () => { throw new Error('unexpected read'); }), /geometry|garment mask/);
    }
    await assert.rejects(loadLifestyleTemplate(manifest, 'white', async () => Buffer.alloc(0)), /mask unavailable/);
});
