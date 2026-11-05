import { protectedConfig } from "./protected-config.mjs";
import { pathToFileURL } from 'node:url';
const workflow = 'bentbrain/bent-mono/.github/workflows/inspect-printify-product.yml@refs/heads/main';
const stop = reason => new Error(`Printify product inspection stopped: ${reason}`);
const scalar = value => value === null ? 'null' : typeof value === 'string'
    ? (value.length ? 'nonempty string' : 'empty string')
    : typeof value === 'number' ? (!Number.isFinite(value) ? 'nonfinite number'
        : Number.isInteger(value) ? (value > 0 ? 'positive integer' : value === 0 ? 'zero' : 'negative integer') : 'finite noninteger')
        : typeof value;
const fields = (value, names) => Object.fromEntries(names.map(name => [name, scalar(value?.[name])]));
const list = (value, project) => Array.isArray(value)
    ? { type: 'array', length: value.length, items: value.slice(0, 100).map(project) }
    : { type: scalar(value) };
// Only fixed field names and types leave the runner. No title, SKU, artwork URL,
// image bytes, customer data, token, or raw upstream response is logged.
export function productShape(value) {
    return {
        ...fields(value, ['blueprint_id', 'description', 'id', 'is_locked', 'print_provider_id', 'shop_id', 'title', 'visible']),
        variants: list(value?.variants, item => fields(item, ['cost', 'id', 'is_available', 'is_enabled', 'price', 'sku'])),
        print_areas: list(value?.print_areas, area => ({
            variant_ids: list(area?.variant_ids, scalar),
            placeholders: list(area?.placeholders, placeholder => ({
                ...fields(placeholder, ['decoration_method', 'position']),
                images: list(placeholder?.images, item => fields(item, ['angle', 'height', 'id', 'scale', 'type', 'width', 'x', 'y'])),
            })),
        })),
    };
}
export async function inspectProduct(env = process.env, request = fetch) {
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'bentbrain/bent-mono' ||
        env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") || env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") ||
        env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
        env.GITHUB_RUN_ATTEMPT !== '1' || env.GITHUB_WORKFLOW_REF !== workflow) {
        throw stop('exact first-attempt Production workflow required.');
    }
    if (!/^[a-f0-9]{24}$/.test(env.PRINTIFY_PRODUCT_ID ?? '') ||
        !/^[1-9][0-9]*$/.test(env.PRINTIFY_SHOP_ID ?? '') || !env.PRINTIFY_API_TOKEN) {
        throw stop('exact product, shop and protected token required.');
    }
    let response;
    try {
        response = await request(`https://api.printify.com/v1/shops/${env.PRINTIFY_SHOP_ID}/products/${env.PRINTIFY_PRODUCT_ID}.json`, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${env.PRINTIFY_API_TOKEN}`, Accept: 'application/json', 'User-Agent': 'bent.shop' },
        });
    }
    catch {
        throw stop('read response not confirmed.');
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw stop(`read returned HTTP ${response.status}.`);
    }
    let value;
    try {
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024)
                throw Error('bound');
            chunks.push(chunk);
        }
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw stop('bounded JSON response required.');
    }
    if (value?.id !== env.PRINTIFY_PRODUCT_ID || String(value?.shop_id) !== env.PRINTIFY_SHOP_ID) {
        throw stop('product or shop identity differs.');
    }
    return { applicationMutations: false, productIdentityVerified: true, shape: productShape(value) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await inspectProduct()));
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
