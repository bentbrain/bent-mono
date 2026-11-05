import { protectedConfig } from "./protected-config.mjs";
import { pathToFileURL } from "node:url";
import { assertProductionIdentityContext } from "./native-production-identity.mjs";
import { workerContentManifest } from "./native-ci-worker.mjs";
const ACCOUNT = protectedConfig("cloudflareAccountId"), DATABASE = protectedConfig("resource_1a1378f0d1dc");
const ROOT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const check = (value, reason) => { if (!value)
    throw new Error(`Production read-only inspection stopped: ${reason}`); };
export async function inspectProductionCloudflare(env = process.env, request = fetch) {
    assertProductionIdentityContext(env);
    check(env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT && env.WORKER_URL === "https://forever-tee-api.socialqueue.workers.dev" &&
        typeof env.CLOUDFLARE_API_TOKEN === "string" && env.CLOUDFLARE_API_TOKEN.length > 0, "exact Production context.");
    const get = async (path) => {
        const response = await request(`${ROOT}${path}`, { redirect: "error", signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
        check(response.ok, `read returned HTTP ${response.status}.`);
        return response;
    };
    const api = async (path) => {
        const value = await (await get(path)).json();
        check(value.success === true, "read was not confirmed.");
        return value.result;
    };
    const query = async (sql) => {
        // The only POSTs are these fixed SELECT statements. There is no caller-
        // supplied SQL, mutation method, deployment, artwork read or credential write.
        check(["SELECT name FROM d1_migrations ORDER BY name", "SELECT name FROM pragma_table_info('story_video_jobs')",
            "SELECT status, COUNT(*) AS count FROM story_video_jobs GROUP BY status"].includes(sql), "unknown read statement.");
        const response = await request(`${ROOT}/d1/database/${DATABASE}/query`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql, params: [] }) });
        check(response.ok, "database read failed.");
        const value = await response.json();
        check(value.success === true && value.result?.length === 1 && value.result[0].success === true, "database read was not confirmed.");
        return value.result[0].results;
    };
    const database = await api(`/d1/database/${DATABASE}`);
    check(database.uuid === DATABASE && database.name === "forever-tee-designs-production", "database identity.");
    const settings = await api("/workers/scripts/forever-tee-api/settings");
    check(Array.isArray(settings.bindings), "Worker bindings unavailable.");
    const binding = name => {
        const values = settings.bindings.filter(item => item.name === name);
        check(values.length <= 1, "duplicate Worker binding.");
        return values[0];
    };
    check(binding("DB")?.type === "d1" && binding("DB").id === DATABASE &&
        binding("DESIGN_ARTWORK")?.type === "r2_bucket" && binding("DESIGN_ARTWORK").bucket_name === "forever-tee-design-artwork-production", "existing Production database/artwork bindings.");
    const provider = binding("STORY_VIDEO_PROVIDER");
    check(!provider || provider.type === "plain_text" && provider.text === "cloudflare", "unexpected provider; inspect the actual cutover history.");
    const queueBinding = binding("STORY_VIDEO_JOBS");
    check(queueBinding?.type === "queue" && queueBinding.queue_name === "forever-tee-story-video-production", "queue name binding.");
    // Worker settings identify queue bindings by name, not by queue_id. Resolve
    // the fixed name in this account, then independently verify its detail and
    // consumer. Missing or ambiguous results do not relax the admission checks.
    const queues = await api("/queues");
    check(Array.isArray(queues), "queue inventory.");
    const matches = queues.filter(queue => queue.queue_name === queueBinding.queue_name);
    check(matches.length === 1 && /^[a-f0-9]{32}$/.test(matches[0].queue_id ?? ""), "unique Production queue identity.");
    const queueId = matches[0].queue_id;
    check(queueBinding.queue_id === undefined || queueBinding.queue_id === queueId, "conflicting queue binding identity.");
    const queue = await api(`/queues/${queueId}`), consumers = await api(`/queues/${queueId}/consumers`);
    const consumerNames = [consumers?.[0]?.script_name, consumers?.[0]?.script, consumers?.[0]?.service].filter(name => name !== undefined);
    check(queue.queue_name === "forever-tee-story-video-production" && queue.queue_id === queueId &&
        Array.isArray(consumers) && consumers.length === 1 && consumerNames.length > 0 && consumerNames.every(name => name === "forever-tee-api") &&
        consumers[0].type === "worker" && consumers[0].settings?.max_concurrency === 1, "Production queue identity and Cloudflare concurrency.");
    const deployments = await api("/workers/scripts/forever-tee-api/deployments"), versions = await api("/workers/scripts/forever-tee-api/versions");
    const active = deployments.deployments?.[0]?.versions;
    check(active?.length === 1 && active[0].percentage === 100 && versions.items?.[0]?.id === active[0].version_id, "active/latest version mismatch.");
    const content = await workerContentManifest(await get("/workers/scripts/forever-tee-api/content/v2"));
    const after = await api("/workers/scripts/forever-tee-api/deployments");
    const latest = await api("/workers/scripts/forever-tee-api/versions");
    check(after.deployments?.[0]?.versions?.length === 1 && after.deployments[0].versions[0].version_id === active[0].version_id &&
        after.deployments[0].versions[0].percentage === 100 && latest.items?.[0]?.id === active[0].version_id, "Worker changed during inspection.");
    const migrations = await query("SELECT name FROM d1_migrations ORDER BY name");
    const columns = await query("SELECT name FROM pragma_table_info('story_video_jobs')");
    const counts = await query("SELECT status, COUNT(*) AS count FROM story_video_jobs GROUP BY status");
    const missing = [];
    if (binding("STORY_VIDEOS")?.type !== "r2_bucket" || binding("STORY_VIDEOS").bucket_name !== "forever-tee-story-videos-production")
        missing.push("native video R2 binding");
    if (binding("STORY_VIDEO_NOTIFICATIONS")?.type !== "durable_object_namespace")
        missing.push("push notification binding");
    for (const name of ["STORY_VIDEO_GRANT_SECRET", "STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY"]) {
        if (binding(name)?.type !== "secret_text")
            missing.push(name);
    }
    if (!columns.some(row => row.name === "execution_id"))
        missing.push("execution fence migration");
    return { productionInspected: true, sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, provider: "cloudflare", workerVersion: active[0].version_id,
        workerContent: content, databaseId: DATABASE, queueId, queueSettings: consumers[0].settings,
        migrations: migrations.map(row => row.name), jobCounts: counts, missing, awsAccessAttempted: false, applicationMutations: false,
        nativePromotionReady: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await inspectProductionCloudflare()));
    }
    catch (error) {
        console.error(error instanceof Error && error.message.startsWith("Production read-only inspection stopped:") ? error.message : "Production inspection failed; response content was not logged.");
        process.exitCode = 1;
    }
}
