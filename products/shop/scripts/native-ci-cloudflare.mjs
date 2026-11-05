import { protectedConfig } from "./protected-config.mjs";
import { assertActionsIdentityContext } from "./native-ci-identity.mjs";
import { createHash } from "node:crypto";
import { developmentOperation } from "./native-ci-operation.mjs";
export const CLOUDFLARE_ACCOUNT = protectedConfig("cloudflareAccountId");
export const DEVELOPMENT_DATABASE = protectedConfig("resource_fb377032d2f5");
const WORKER = "forever-tee-api-development";
const QUEUE = protectedConfig("resource_66448984d52e");
const ROOT = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}`;
const check = (value, reason) => { if (!value)
    throw new Error(`Native Cloudflare verification failed: ${reason}`); };
export function developmentCloudflare(env = process.env, request = fetch) {
    assertActionsIdentityContext(env);
    check(env.GITHUB_WORKFLOW_REF === `bentbrain/bent-mono/.github/workflows/native-development.yml@${env.GITHUB_REF}` &&
        env.CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_ACCOUNT && typeof env.CLOUDFLARE_API_TOKEN === "string" && env.CLOUDFLARE_API_TOKEN.length > 0 &&
        env.WORKER_URL === "https://forever-tee-api-development.socialqueue.workers.dev", "exact personal Development context.");
    const send = async (path, body, method = body ? "POST" : "GET") => {
        let response;
        try {
            response = await request(`${ROOT}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
                ...(body ? { body: JSON.stringify(body) } : {}) });
        }
        catch {
            throw new Error("Development Cloudflare response was not confirmed; inspect state before retrying mutations.");
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Development Cloudflare request failed with HTTP ${response.status}; response content was not logged.`);
        }
        return response;
    };
    const api = async (path, body, method) => {
        const value = await (await send(path, body, method)).json();
        check(value.success === true, "Cloudflare did not confirm success.");
        return value.result;
    };
    const artwork = async (key, bytes) => {
        const savedKey = /^designs\/[a-f0-9-]{36}\/artwork\/[a-f0-9]{64}$/.test(key);
        check(savedKey, "Development artwork key.");
        if (bytes !== undefined)
            check(Buffer.isBuffer(bytes) && bytes.length <= 25000000 &&
                createHash("sha256").update(bytes).digest("hex") === key.split("/").at(-1), "new qualification artwork only.");
        const response = await request(`${ROOT}/r2/buckets/forever-tee-design-artwork-development/objects/${key}`, {
            method: bytes === undefined ? "GET" : "PUT", redirect: "error", signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(bytes === undefined ? {} : { "Content-Type": "image/png", "If-None-Match": "*" }) },
            ...(bytes === undefined ? {} : { body: bytes }),
        });
        check(response.ok, "Development artwork transfer was not confirmed.");
        return response;
    };
    const removeObject = async (bucket, key, pattern, { inspect = true } = {}) => {
        check(pattern.test(key), "Development cleanup object key.");
        if (inspect) {
            const existing = await request(`${ROOT}/r2/buckets/${bucket}/objects/${key}`, {
                method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
            });
            await existing.body?.cancel();
            if (existing.status === 404)
                return;
            check(existing.ok, "Development cleanup object inspection failed.");
        }
        const response = await request(`${ROOT}/r2/buckets/${bucket}/objects/${key}`, {
            method: "DELETE", redirect: "error", signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        });
        check(response.ok || response.status === 404, "Development cleanup object deletion was not confirmed.");
        await response.body?.cancel();
    };
    return {
        settings: () => api(`/workers/scripts/${WORKER}/settings`),
        schedules: () => api(`/workers/scripts/${WORKER}/schedules`),
        repairSchedule: () => {
            check(developmentOperation(env) === "repair-schedule", "explicit schedule repair operation.");
            return api(`/workers/scripts/${WORKER}/schedules`, [{ cron: "* * * * *" }], "PUT");
        },
        deployments: () => api(`/workers/scripts/${WORKER}/deployments`),
        versions: () => api(`/workers/scripts/${WORKER}/versions`),
        content: () => send(`/workers/scripts/${WORKER}/content/v2`),
        version: id => {
            check(/^[a-f0-9-]{36}$/.test(id), "Worker version identifier.");
            return api(`/workers/scripts/${WORKER}/versions/${id}`);
        },
        deployExistingVersion: id => {
            check(/^[a-f0-9-]{36}$/.test(id), "Worker rollback version identifier.");
            // No force override: changed secrets or incompatible migrations must stop rollback.
            return api(`/workers/scripts/${WORKER}/deployments`, { strategy: "percentage", versions: [{ version_id: id, percentage: 100 }] });
        },
        database: () => api(`/d1/database/${DEVELOPMENT_DATABASE}`),
        readArtwork: key => artwork(key),
        createQualificationArtwork: (key, bytes) => artwork(key, bytes),
        deleteQualificationArtwork: (key, options) => removeObject("forever-tee-design-artwork-development", key, /^(?:designs\/[a-f0-9-]{36}\/artwork\/[a-f0-9]{64}|designs\/[a-f0-9-]{36}\/artwork-preview-[a-f0-9]{64}-[a-z0-9-]+\.webp|print-assets\/(?:blobs\/[a-f0-9]{64}|[a-f0-9-]{36}\/[a-z0-9_-]+:[0-9]+x[0-9]+\/[a-f0-9]{64})\.png)$/, options),
        deleteQualificationVideo: (key, options) => removeObject("forever-tee-story-videos-development", key, /^story-videos\/v[0-9]+\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/(?:black|cream|white)\.mp4$/, options),
        duplicateQualificationDelivery: revisionId => {
            check(/^[a-f0-9-]{36}$/.test(revisionId), "fixture revision ID.");
            return api(`/queues/${QUEUE}/messages`, { body: { designRevisionId: revisionId }, content_type: "json" });
        },
        consumers: () => api(`/queues/${QUEUE}/consumers`),
        printConsumers: async () => {
            const queues = await api("/queues?name=forever-tee-print-assets-development");
            check(Array.isArray(queues) && queues.length === 1 && queues[0].queue_name === "forever-tee-print-assets-development" &&
                /^[a-f0-9]{32}$/.test(queues[0].queue_id), "exact Development print queue.");
            return api(`/queues/${queues[0].queue_id}/consumers`);
        },
        storyVideoLifecycle: () => api("/r2/buckets/forever-tee-story-videos-development/lifecycle"),
        updateStoryVideoLifecycle: rules => {
            check(Array.isArray(rules) && rules.length > 0 && rules.length <= 1000, "bounded Development lifecycle rules.");
            return api("/r2/buckets/forever-tee-story-videos-development/lifecycle", { rules }, "PUT");
        },
        restoreConsumer: (id, settings) => {
            check(/^[a-f0-9]{32}$/.test(id) && settings && Number.isInteger(settings.max_concurrency) &&
                settings.max_concurrency >= 1 && settings.max_concurrency <= 2, "bounded Development queue consumer.");
            return api(`/queues/${QUEUE}/consumers/${id}`, { type: "worker", script_name: WORKER, settings }, "PUT");
        },
        batch: async (statements) => {
            check(Array.isArray(statements) && statements.length > 0 && statements.length <= 100 &&
                statements.every(statement => typeof statement.sql === "string" && statement.sql.length > 0 && Array.isArray(statement.params)), "bounded D1 batch.");
            const results = await api(`/d1/database/${DEVELOPMENT_DATABASE}/query`, { batch: statements });
            check(Array.isArray(results) && results.length === statements.length && results.every(result => result.success === true), "D1 did not confirm the transaction.");
            return results;
        },
        query: async (sql, params = []) => {
            check(typeof sql === "string" && sql.length > 0 && Array.isArray(params), "D1 statement.");
            const results = await api(`/d1/database/${DEVELOPMENT_DATABASE}/query`, { sql, params });
            check(Array.isArray(results) && results.length > 0 && results.every(result => result.success === true), "D1 did not confirm every statement.");
            return results;
        },
    };
}
export async function inspectDevelopmentCloudflare(env = process.env) {
    const cf = developmentCloudflare(env);
    const database = await cf.database();
    check(database.uuid === DEVELOPMENT_DATABASE && database.name === "forever-tee-designs-development", "D1 identity.");
    const settings = await cf.settings();
    check(Array.isArray(settings.bindings), "Worker bindings.");
    const binding = name => {
        const matches = settings.bindings.filter(item => item.name === name);
        check(matches.length === 1, `missing or duplicate ${name} binding.`);
        return matches[0];
    };
    check(binding("DB").type === "d1" && binding("DB").id === DEVELOPMENT_DATABASE, "Worker D1 binding.");
    for (const [name, bucket] of [["STORY_VIDEOS", "forever-tee-story-videos-development"], ["DESIGN_ARTWORK", "forever-tee-design-artwork-development"]]) {
        check(binding(name).type === "r2_bucket" && binding(name).bucket_name === bucket, "Worker R2 binding.");
    }
    for (const name of ["STORY_VIDEO_GRANT_SECRET", "STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY",
        "BENT_SHIRT_OPERATIONS_SECRET", "FOREVER_TEE_API_SHARED_SECRET"])
        check(binding(name).type === "secret_text", `${name} must remain encrypted.`);
    check(binding("STORY_VIDEO_PROVIDER").type === "plain_text" && binding("STORY_VIDEO_PROVIDER").text === "lambda", "live native provider.");
    check(binding("STORY_VIDEO_LAMBDA_FUNCTION").text === "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development", "live Lambda target.");
    check(binding("STORY_VIDEO_NOTIFICATIONS").type === "durable_object_namespace", "readiness notification binding.");
    const deployments = await cf.deployments();
    check(Array.isArray(deployments.deployments) && deployments.deployments.length > 0, "deployment history.");
    const active = deployments.deployments[0];
    check(active.versions?.length === 1 && active.versions[0].percentage === 100 &&
        /^[a-f0-9-]{36}$/.test(active.versions[0].version_id), "single live Worker version.");
    const schema = await cf.query("SELECT name FROM pragma_table_info('story_video_jobs')");
    const counts = await cf.query("SELECT status, COUNT(*) AS count FROM story_video_jobs GROUP BY status");
    return { cloudflareVerified: true, environment: "development", workerVersion: active.versions[0].version_id,
        deploymentId: active.id, executionFencePresent: schema[0].results.some(row => row.name === "execution_id"),
        jobCounts: counts[0].results.map(row => ({ status: row.status, count: row.count })), applicationMutations: false };
}
