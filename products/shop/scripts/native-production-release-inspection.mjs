import { protectedConfig } from "./protected-config.mjs";
import { assertProductionContext, productionAWS } from "./native-production-ci.mjs";
import { productionCloudflare, inspectProductionConsumer } from "./native-production-cloudflare.mjs";
import { productionReleaseStore } from "./native-production-release-store.mjs";
import { workerContentManifest, versionResourcesDigest } from "./native-ci-worker.mjs";
import { summarizeReleaseEvents } from "./native-release-timing.mjs";
export function bindingComparison(bindings, variables) {
    return Object.entries(variables).filter(([name]) => name.startsWith("STORY_VIDEO_")).map(([name, expected]) => {
        const matches = bindings.filter(binding => binding.name === name), value = matches[0];
        return { name, count: matches.length, type: value?.type, textMatches: value?.text === expected, jsonMatches: value?.json === JSON.stringify(expected),
            ...(name === "STORY_VIDEO_PROVIDER" ? { textProvider: ["cloudflare", "lambda"].includes(value?.text) ? value.text : null,
                jsonProvider: ['"cloudflare"', '"lambda"'].includes(value?.json) ? value.json : null } : {}) };
    });
}
const SAFE_CANARY_ASSET_ERRORS = [
    /^Print asset rendering returned [1-5][0-9]{2}\.$/,
    /^Rendered print asset exceeds the storage limit\.$/,
    /^Rendered print asset has invalid PNG geometry\.$/,
    /^Print asset rendering capacity was not available in time\.$/,
    /^Network connection lost\.$/,
];
const CANARY_ARTWORK_SHA256 = "ed234ac311653a0c78954716d16266f2ef124b37ddb780d96d7d3fa5ad6b60bc";
const SAFE_STORY_VIDEO_ERRORS = [
    /^Incomplete renderer batch\.$/,
    /^Invalid renderer (?:batch|event|result)\.$/,
    /^Missing renderer stream\.$/,
    /^Network connection lost\.$/,
    /^Renderer could not complete the batch\.$/,
    /^Renderer request failed: [1-5][0-9]{2}\.$/,
    /^Renderer sent events after completion\.$/,
    /^Renderer stream ended before completion\.$/,
    /^STALE_RENDER_EXHAUSTED$/,
    /^The product mockup (?:could not be loaded|is unavailable)\.$/,
    /^The renderer omitted pending videos\.$/,
    /^Unknown renderer event\.$/,
];
export function canaryAssetObservation(rows) {
    return rows.slice(0, 8).map(row => ({
        geometry: typeof row.geometry_key === "string" && /^[a-z0-9][a-z0-9_-]{0,31}:[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$/.test(row.geometry_key)
            ? row.geometry_key : "invalid",
        status: ["pending", "ready", "failed"].includes(row.status) ? row.status : "invalid",
        width: Number.isSafeInteger(row.width_px) && row.width_px > 0 ? row.width_px : null,
        height: Number.isSafeInteger(row.height_px) && row.height_px > 0 ? row.height_px : null,
        error: typeof row.last_error === "string" && SAFE_CANARY_ASSET_ERRORS.some(pattern => pattern.test(row.last_error))
            ? row.last_error : row.last_error === null ? null : "unclassified",
    }));
}
export function storyVideoJobObservation(rows) {
    return rows.slice(0, 100).map(row => ({
        status: ["queued", "rendering", "ready", "failed"].includes(row.status) ? row.status : "invalid",
        attempts: Number.isSafeInteger(row.attempt_count) && row.attempt_count >= 0 && row.attempt_count <= 3
            ? row.attempt_count : null,
        count: Number.isSafeInteger(row.count) && row.count > 0 ? row.count : null,
        missingPlacement: Number.isSafeInteger(row.missing_placement) && row.missing_placement >= 0
            ? row.missing_placement : null,
        error: typeof row.last_error === "string" && SAFE_STORY_VIDEO_ERRORS.some(pattern => pattern.test(row.last_error))
            ? row.last_error : row.last_error === null ? null : "unclassified",
    }));
}
export async function inspectProductionRelease(env) {
    assertProductionContext(env);
    if (env.NATIVE_OPERATION !== "inspect-release" || !/^native-[1-9][0-9]+$/.test(env.NATIVE_VERIFY_RELEASE ?? ""))
        throw Error("Explicit recorded Production inspection required.");
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call);
    const releaseId = env.NATIVE_VERIFY_RELEASE;
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const records = await query("SELECT stage,payload,created_at FROM native_video_release_events WHERE release_id=? ORDER BY created_at,stage", [releaseId]);
    const prepared = records.find(row => row.stage === "prepared");
    if (!prepared)
        throw Error("Original preparation is missing.");
    const preparation = JSON.parse(prepared.payload), settings = await cf.settings();
    // Inspection must capture a disagreement, not stop at the release verifier's
    // active/latest guard. Do not call this unverified snapshot a rollback artifact.
    const deployments = await cf.deployments(), versions = await cf.versions();
    const activeVersions = deployments.deployments?.[0]?.versions ?? [];
    const latestVersion = versions.items?.[0]?.id;
    const versionRecords = [];
    for (const id of new Set([...activeVersions.map(active => active.version_id), latestVersion]))
        versionRecords.push(await cf.version(id));
    const worker = { activeVersions, latestVersion, content: await workerContentManifest(await cf.content()),
        versionResources: versionRecords.map(version => ({ id: version.id, sha256: versionResourcesDigest(version),
            bindings: bindingComparison(Array.isArray(version.resources.bindings) ? version.resources.bindings : [], preparation.variables) })),
        workerBytesVerified: false };
    const control = await query("SELECT paused,release_id,paused_at,current_release_id FROM native_video_release_control WHERE singleton=1");
    const consumer = await inspectProductionConsumer(cf), schedules = await cf.schedules();
    const migrations = await query("SELECT name FROM d1_migrations ORDER BY name");
    const jobs = await query("SELECT status,COUNT(*) AS count FROM story_video_jobs GROUP BY status");
    const eligibleJobs = storyVideoJobObservation(await query(`
    SELECT jobs.status, jobs.attempt_count, jobs.last_error, COUNT(*) AS count,
      SUM(CASE WHEN products.placement_x IS NULL OR products.placement_y IS NULL
        OR products.placement_width IS NULL OR products.placement_depth IS NULL THEN 1 ELSE 0 END) AS missing_placement
    FROM story_video_jobs AS jobs
    JOIN products ON products.id = jobs.product_id
      AND products.design_revision_id = jobs.design_revision_id
      AND products.status = 'active'
    WHERE jobs.renderer_version = 'story-video-renderer-v7'
    GROUP BY jobs.status, jobs.attempt_count, jobs.last_error
    ORDER BY jobs.status, jobs.attempt_count
    LIMIT 100
  `));
    const canaryAssets = canaryAssetObservation(await query(`
    SELECT print_assets.geometry_key, print_assets.status, print_assets.width_px,
      print_assets.height_px, print_assets.last_error
    FROM print_assets
    JOIN products ON products.id = print_assets.configured_product_id
    WHERE products.design_id = (
      SELECT id FROM designs
      WHERE sha256 = ?
      ORDER BY created_at DESC LIMIT 1
    )
    ORDER BY print_assets.geometry_key
    LIMIT 8
  `, [CANARY_ARTWORK_SHA256]));
    const stageTimings = summarizeReleaseEvents(records);
    const evidence = await store.save("release-inspection.json", Buffer.from(JSON.stringify({ releaseId, records, stageTimings, settings, worker, versionRecords, control, consumer, schedules, migrations, jobs, eligibleJobs, canaryAssets })));
    return { productionReleaseInspected: true, releaseId, applicationMutations: false, control, stages: records.map(row => row.stage), worker, consumer, schedules,
        stageTimings, lastMigration: migrations.at(-1)?.name, jobs, eligibleJobs, canaryAssets, bindings: bindingComparison(settings.bindings, preparation.variables), evidence };
}
