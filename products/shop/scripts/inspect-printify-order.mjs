import { protectedConfig } from "./protected-config.mjs";
import { pathToFileURL } from 'node:url';
const workflow = 'bentbrain/bent-mono/.github/workflows/inspect-printify-order.yml@refs/heads/main';
const stop = reason => new Error(`Printify order inspection stopped: ${reason}`);
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
export function orderShape(value) {
    return {
        ...fields(value, ['id', 'external_id', 'status', 'shipping_method', 'sent_to_production_at', 'created_at']),
        metadata: fields(value?.metadata, ['order_type', 'shop_order_id', 'shop_order_label', 'shop_fulfilled_at']),
        address_to: fields(value?.address_to, ['address1', 'address2', 'city', 'company', 'country', 'email', 'first_name', 'last_name', 'phone', 'region', 'zip']),
        line_items: list(value?.line_items, item => ({
            ...fields(item, ['cost', 'external_id', 'print_provider_id', 'product_id', 'quantity', 'shipping_cost', 'status', 'variant_id']),
            metadata: fields(item?.metadata, ['external_id', 'price', 'sku']),
        })),
        shipments: list(value?.shipments, item => fields(item, ['carrier', 'delivered_at', 'number', 'url'])),
    };
}
export async function inspectOrder(env = process.env, request = fetch) {
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'bentbrain/bent-mono' ||
        env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") || env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") ||
        env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
        env.GITHUB_RUN_ATTEMPT !== '1' || env.GITHUB_WORKFLOW_REF !== workflow) {
        throw stop('exact first-attempt Production workflow required.');
    }
    if (env.PRINTIFY_ORDER_ID !== protectedConfig("inspectionProviderOrderId") ||
        env.PRINTIFY_SHOP_ID !== protectedConfig("resource_a41528a2917c") || !env.PRINTIFY_API_TOKEN) {
        throw stop('exact order, shop and protected token required.');
    }
    let response;
    try {
        response = await request(`https://api.printify.com/v1/shops/${env.PRINTIFY_SHOP_ID}/orders/${env.PRINTIFY_ORDER_ID}.json`, {
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
    if (value?.id !== env.PRINTIFY_ORDER_ID) {
        throw stop('order identity differs.');
    }
    return { applicationMutations: false, orderIdentityVerified: true, shape: orderShape(value) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await inspectOrder()));
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
