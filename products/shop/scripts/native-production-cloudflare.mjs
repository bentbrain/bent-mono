import { protectedConfig } from "./protected-config.mjs";
import { assertProductionContext } from "./native-production-ci.mjs";
const PRODUCTION_CF_ACCOUNT = protectedConfig("cloudflareAccountId");
export const PRODUCTION_DB = protectedConfig("resource_1a1378f0d1dc");
const PRODUCTION_QUEUE = protectedConfig("resource_2f27c2bd55b6");
const WORKER = "forever-tee-api";
const check = (value, reason) => { if (!value)
    throw new Error(`Production Cloudflare stopped: ${reason}`); };
const CANARY_ARTWORK_SHA256 = "ed234ac311653a0c78954716d16266f2ef124b37ddb780d96d7d3fa5ad6b60bc";
const FEATURED_VIDEO_RECOVERY_UPDATE = /^UPDATE story_video_jobs SET status='ready', output_byte_size=\?, last_error=NULL, execution_id=NULL, updated_at=\?, rendered_at=\? WHERE id=\? AND renderer_version=\? AND status='failed' AND attempt_count=3 AND last_error=\? AND design_revision_id=\? AND product_id=\?$/;
const PRODUCT_SWEEP_COLOR_UPDATE = /^UPDATE designs SET default_product_color=\?, default_product_color_model=\?, default_product_color_status='complete' WHERE id=\? AND status='ready' AND deleted_at IS NULL AND default_product_color_status='fallback' AND artwork_key=\? AND sha256=\?$/;
const PRODUCT_SWEEP_DEFAULT_SYNC = /^UPDATE products SET default_color=\(SELECT designs\.default_product_color FROM designs WHERE designs\.id=products\.design_id\) WHERE status='active' AND design_id IS NOT NULL AND default_color<>\(SELECT designs\.default_product_color FROM designs WHERE designs\.id=products\.design_id\)$/;
const PRODUCT_SWEEP_VIDEO_RETRY = /^UPDATE story_video_jobs SET status='queued', attempt_count=0, last_error='PRODUCT_SWEEP_RETRY', execution_id=NULL, updated_at=\? WHERE renderer_version=\? AND status='failed' AND attempt_count>=3 AND EXISTS \(SELECT 1 FROM products WHERE products\.id=story_video_jobs\.product_id AND products\.status='active' AND products\.design_revision_id=story_video_jobs\.design_revision_id\)$/;
const PRODUCT_SWEEP_VIDEO_ID_REPAIR = /^UPDATE story_video_jobs SET id=\?, status='queued', attempt_count=0, last_error='PRODUCT_SWEEP_ID_REPAIR', execution_id=NULL, updated_at=\? WHERE id=\? AND renderer_version=\? AND status='failed' AND attempt_count=3 AND last_error='Invalid render grant\.' AND length\(id\)=39 AND substr\(id,37,3\)='-v7'$/;
const PRODUCT_SWEEP_LEGACY_PRODUCT = /^INSERT INTO products \(id, base_product_id, design_id, design_revision_id, shopify_handle, placement_x, placement_y, placement_width, placement_depth, projection_version, default_color, status, created_at, deleted_at\) SELECT \?, \?, designs\.id, source\.design_revision_id, base\.shopify_handle, \?, \?, \?, \?, 'safe-margin-v1', designs\.default_product_color, 'active', \?, NULL FROM designs JOIN products AS source ON source\.design_id=designs\.id AND source\.status='active' AND source\.base_product_id=\? JOIN products AS base ON base\.id=\? AND base\.status='active' AND base\.design_id IS NULL WHERE designs\.id=\? AND designs\.owner_id IS NULL AND designs\.status='ready' AND designs\.deleted_at IS NULL AND designs\.finalized_at IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM products AS existing WHERE existing\.design_id=designs\.id AND existing\.status='active' AND existing\.base_product_id=\?\)$/;
const PRODUCT_SWEEP_VIDEO_INSERT = /^INSERT INTO story_video_jobs \(id, product_id, design_revision_id, colour, renderer_version, story_key, status, attempt_count, output_byte_size, last_error, created_at, updated_at, rendered_at\) SELECT \?, products\.id, products\.design_revision_id, \?, \?, \?, 'queued', 0, NULL, NULL, \?, \?, NULL FROM products WHERE products\.id=\? AND products\.status='active' AND products\.design_revision_id=\? ON CONFLICT \(product_id, colour, renderer_version\) DO NOTHING$/;
const FEATURED_ARTWORK_KEY = "designs/" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "/artwork/" + protectedConfig("resource_73e91e639e8e");
const FEATURED_VIDEO_KEYS = new Set([
    "story-videos/v7/" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "/" + "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4" + "/black.mp4",
    "story-videos/v7/" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "/" + "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4" + "/white.mp4",
    "story-videos/v7/" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "/" + "55b53491-a09d-4f50-b9f6-73fbd3fabff9" + "/black.mp4",
    "story-videos/v7/" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "/" + "55b53491-a09d-4f50-b9f6-73fbd3fabff9" + "/cream.mp4",
]);
export function isProductionCanaryArtworkKey(key) {
    return new RegExp(`^designs/[a-f0-9-]{36}/artwork/${CANARY_ARTWORK_SHA256}$`).test(key ?? "");
}
export function productionCloudflare(env, request = fetch) {
    assertProductionContext(env);
    check(env.CLOUDFLARE_ACCOUNT_ID === PRODUCTION_CF_ACCOUNT && env.WORKER_URL === "https://forever-tee-api.socialqueue.workers.dev" &&
        typeof env.CLOUDFLARE_API_TOKEN === "string" && env.CLOUDFLARE_API_TOKEN.length > 0, "exact personal Production context.");
    const creationRecovery = env.NATIVE_OPERATION === "recover-release" && env.NATIVE_VERIFY_RELEASE === "native-" + protectedConfig("resource_0c384d07e61b");
    const send = async (path, body, method = body === undefined ? "GET" : "POST") => {
        let response;
        try {
            response = await request(`https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_CF_ACCOUNT}${path}`, {
                method, redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
        }
        catch {
            throw new Error("Production Cloudflare response uncertain; inspect state before retrying writes.");
        }
        check(response.ok, `request returned HTTP ${response.status}; private response omitted.`);
        return response;
    };
    const api = async (...args) => { const value = await (await send(...args)).json(); check(value.success === true, "unconfirmed response."); return value.result; };
    return {
        settings: () => api(`/workers/scripts/${WORKER}/settings`),
        deployments: () => api(`/workers/scripts/${WORKER}/deployments`), versions: () => api(`/workers/scripts/${WORKER}/versions`),
        content: () => send(`/workers/scripts/${WORKER}/content/v2`),
        version: id => { check(/^[a-f0-9-]{36}$/.test(id), "version identifier."); return api(`/workers/scripts/${WORKER}/versions/${id}`); },
        deployExistingVersion: id => {
            check((["release", "rollback", "recover-rehearsal"].includes(env.NATIVE_OPERATION) ||
                creationRecovery && id === protectedConfig("resource_85e4b96e18fd")) && /^[a-f0-9-]{36}$/.test(id), "explicit paired version deployment.");
            return api(`/workers/scripts/${WORKER}/deployments`, { strategy: "percentage", versions: [{ version_id: id, percentage: 100 }] });
        },
        consumers: () => api(`/queues/${PRODUCTION_QUEUE}/consumers`),
        printConsumers: async () => {
            const queues = await api("/queues?name=forever-tee-print-assets-production");
            check(Array.isArray(queues) && queues.length === 1 && queues[0].queue_name === "forever-tee-print-assets-production" &&
                /^[a-f0-9]{32}$/.test(queues[0].queue_id), "exact Production print queue.");
            return api(`/queues/${queues[0].queue_id}/consumers`);
        },
        database: () => api(`/d1/database/${PRODUCTION_DB}`),
        query: async (sql, params = []) => {
            check(typeof sql === "string" && sql.length > 0 && Array.isArray(params), "D1 statement.");
            const normalized = sql.replace(/\s+/g, " ").trim();
            const readOnly = /^SELECT\s/i.test(normalized) && !normalized.includes(";");
            const featuredRecovery = env.NATIVE_OPERATION === "repair-featured-videos" && FEATURED_VIDEO_RECOVERY_UPDATE.test(normalized);
            const productSweep = env.NATIVE_OPERATION === "sweep-products" && [PRODUCT_SWEEP_COLOR_UPDATE,
                PRODUCT_SWEEP_DEFAULT_SYNC, PRODUCT_SWEEP_VIDEO_RETRY, PRODUCT_SWEEP_VIDEO_ID_REPAIR, PRODUCT_SWEEP_LEGACY_PRODUCT,
                PRODUCT_SWEEP_VIDEO_INSERT].some(pattern => pattern.test(normalized));
            check(["release", "rollback", "recover-release", "recover-rehearsal", "recover-canary", "canary", "release-storefront"].includes(env.NATIVE_OPERATION) ||
                readOnly || featuredRecovery || productSweep, "preparation permits only reviewed statements.");
            const results = await api(`/d1/database/${PRODUCTION_DB}/query`, { sql, params });
            check(Array.isArray(results) && results.length > 0 && results.every(value => value.success === true), "unconfirmed D1 statement.");
            return results;
        },
        schedules: () => api(`/workers/scripts/${WORKER}/schedules`),
        canaryArtwork: async (key, bytes) => {
            check(["canary", "release-storefront"].includes(env.NATIVE_OPERATION) && isProductionCanaryArtworkKey(key) &&
                (bytes === undefined || Buffer.isBuffer(bytes) && bytes.length <= 25000000), "bounded canary artifact only.");
            let response;
            try {
                response = await request(`https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_CF_ACCOUNT}/r2/buckets/forever-tee-design-artwork-production/objects/${key}`, {
                    method: bytes === undefined ? "GET" : "PUT", redirect: "error", signal: AbortSignal.timeout(30000),
                    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(bytes === undefined ? {} : { "Content-Type": "image/png", "If-None-Match": "*" }) },
                    ...(bytes === undefined ? {} : { body: bytes }),
                });
            }
            catch {
                throw new Error("Production canary artwork response uncertain; preserve its recorded key before recovery.");
            }
            check(response.ok, "canary artwork request failed.");
            return response;
        },
        featuredArtwork: async (key) => {
            check(env.NATIVE_OPERATION === "repair-featured-videos" && key === FEATURED_ARTWORK_KEY, "exact Featured Design artwork only.");
            let response;
            try {
                response = await request(`https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_CF_ACCOUNT}/r2/buckets/forever-tee-design-artwork-production/objects/${key}`, {
                    method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
                    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
                });
            }
            catch {
                throw new Error("Production Featured Design artwork response uncertain.");
            }
            check(response.ok, "Featured Design artwork request failed.");
            return response;
        },
        productSweepArtwork: async (key) => {
            check(env.NATIVE_OPERATION === "sweep-products" &&
                /^designs\/[a-f0-9-]{36}\/(?:artwork(?:\/[a-f0-9]{64})?|native-production-canary\.png)$/.test(key), "bounded Product sweep artwork only.");
            let response;
            try {
                response = await request(`https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_CF_ACCOUNT}/r2/buckets/forever-tee-design-artwork-production/objects/${key}`, {
                    method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
                    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
                });
            }
            catch {
                throw new Error("Production Product sweep artwork response uncertain.");
            }
            check(response.ok, "Product sweep artwork request failed.");
            return response;
        },
        featuredVideo: async (key, bytes) => {
            check(env.NATIVE_OPERATION === "repair-featured-videos" && FEATURED_VIDEO_KEYS.has(key) &&
                (bytes === undefined || Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32000000), "exact Featured Design video only.");
            let response;
            try {
                response = await request(`https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_CF_ACCOUNT}/r2/buckets/forever-tee-story-videos-production/objects/${key}`, {
                    method: bytes === undefined ? "GET" : "PUT", redirect: "error", signal: AbortSignal.timeout(30000),
                    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
                        ...(bytes === undefined ? {} : { "Content-Type": "video/mp4", "If-None-Match": "*" }) },
                    ...(bytes === undefined ? {} : { body: bytes }),
                });
            }
            catch {
                throw new Error("Production Featured Design video response uncertain; inspect the exact object before retrying.");
            }
            check(response.ok || bytes === undefined && response.status === 404 || bytes !== undefined && response.status === 412, "Featured Design video request failed.");
            return response;
        },
        duplicateCanaryDelivery: revision => {
            check(["canary", "release-storefront"].includes(env.NATIVE_OPERATION) && /^[a-f0-9-]{36}$/.test(revision), "canary revision identifier.");
            return api(`/queues/${PRODUCTION_QUEUE}/messages`, { body: { designRevisionId: revision }, content_type: "json" });
        },
        productSweepDelivery: revision => {
            check(env.NATIVE_OPERATION === "sweep-products" && /^[a-f0-9-]{36}$/.test(revision), "Product sweep revision identifier.");
            return api(`/queues/${PRODUCTION_QUEUE}/messages`, { body: { designRevisionId: revision }, content_type: "json" });
        },
        setSchedule: cron => {
            check((["release", "rollback", "recover-rehearsal"].includes(env.NATIVE_OPERATION) ||
                creationRecovery && cron === "*/15 * * * *") && ["* * * * *", "*/15 * * * *"].includes(cron), "reviewed recovery schedule.");
            return api(`/workers/scripts/${WORKER}/schedules`, [{ cron }], "PUT");
        },
        restoreConsumer: (id, settings) => {
            check((["release", "rollback", "recover-rehearsal"].includes(env.NATIVE_OPERATION) ||
                creationRecovery && id === protectedConfig("resource_64de39452cce") && settings?.max_concurrency === 1 && settings.max_retries === 2) &&
                /^[a-f0-9]{32}$/.test(id) && [1, 2].includes(settings?.max_concurrency) &&
                settings.batch_size === 1 && [2, 100].includes(settings.max_retries) && settings.max_wait_time_ms === 1000 && settings.retry_delay === 10, "exact bounded Cloudflare fallback queue.");
            return api(`/queues/${PRODUCTION_QUEUE}/consumers/${id}`, { type: "worker", script_name: WORKER, settings }, "PUT");
        },
    };
}
export async function inspectProductionConsumer(cf) {
    const values = await cf.consumers(), value = values?.[0];
    const names = [value?.script_name, value?.script, value?.service].filter(name => name !== undefined);
    check(Array.isArray(values) && values.length === 1 && value.type === "worker" && /^[a-f0-9]{32}$/.test(value.consumer_id) &&
        names.length > 0 && names.every(name => name === WORKER) && [1, 2].includes(value.settings?.max_concurrency), "exact single Production consumer.");
    return { consumerId: value.consumer_id, settings: value.settings };
}
export function verifyProductionBindings(settings, { application = false, native = false } = {}) {
    const binding = name => { const matches = settings.bindings?.filter(value => value.name === name); check(matches?.length === 1, `unique ${name} binding.`); return matches[0]; };
    check(binding("DB").type === "d1" && binding("DB").id === PRODUCTION_DB, "Production database binding.");
    check(binding("DESIGN_ARTWORK").type === "r2_bucket" && binding("DESIGN_ARTWORK").bucket_name === "forever-tee-design-artwork-production", "Production artwork binding.");
    check(binding("STORY_VIDEO_JOBS").type === "queue" && binding("STORY_VIDEO_JOBS").queue_name === "forever-tee-story-video-production", "Production queue binding.");
    for (const name of ["BENT_SHIRT_OPERATIONS_SECRET", "FOREVER_TEE_API_SHARED_SECRET"])
        check(binding(name).type === "secret_text", "existing Production secrets retained.");
    if (native) {
        check(binding("STORY_VIDEOS").type === "r2_bucket" && binding("STORY_VIDEOS").bucket_name === "forever-tee-story-videos-production", "native video bucket.");
        check(binding("STORY_VIDEO_NOTIFICATIONS").type === "durable_object_namespace", "notification namespace.");
        for (const name of ["STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", "STORY_VIDEO_GRANT_SECRET"])
            check(binding(name).type === "secret_text", "encrypted native secret.");
    }
    if (application)
        for (const name of ["CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET"])
            check(binding(name).type === "secret_text", `encrypted ${name}.`);
}
