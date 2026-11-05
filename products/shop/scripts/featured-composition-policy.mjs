import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual } from "node:util";
import { printSourceResolution } from "../workers/api/src/print-assets.ts";
import { BACKUP_ACCOUNT } from "./backup-renderer-policy.mjs";
const check = (value, reason) => { if (!value)
    throw Error(`Featured composition stopped: ${reason}`); };
export function compositionContext(env) {
    check(env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted" && env.GITHUB_REPOSITORY === "bentbrain/bent-mono" &&
        env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") && env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") && env.GITHUB_ACTOR_ID === protectedConfig("githubOwnerId") &&
        env.GITHUB_REF === "refs/heads/main" && env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_RUN_ATTEMPT === "1" &&
        /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") && /^[1-9][0-9]+$/.test(env.GITHUB_RUN_ID ?? "") &&
        env.GITHUB_WORKFLOW_REF === "bentbrain/bent-mono/.github/workflows/featured-composition.yml@refs/heads/main", "new owner-dispatched protected main workflow required.");
    check(["development", "production"].includes(env.COMPOSITION_ENVIRONMENT) && ["create", "recover", "cleanup"].includes(env.COMPOSITION_OPERATION) &&
        /^native-[1-9][0-9]+$/.test(env.COMPOSITION_NATIVE_RELEASE ?? "") && env.CLOUDFLARE_ACCOUNT_ID === BACKUP_ACCOUNT &&
        env.CLOUDFLARE_API_TOKEN && env.BENT_SHIRT_OPERATIONS_SECRET && env.RUNNER_TEMP?.startsWith("/"), "exact personal environment and current native release required.");
    const environment = env.COMPOSITION_ENVIRONMENT, production = environment === "production";
    const qualifiedSource = env.COMPOSITION_QUALIFIED_SOURCE || null;
    check(qualifiedSource === null || production && env.COMPOSITION_OPERATION !== "cleanup" && /^[a-f0-9]{40}$/.test(qualifiedSource), "an exact qualified source can be selected only for Production publication.");
    const cleanupSource = env.COMPOSITION_CLEANUP_SOURCE || null;
    check(env.COMPOSITION_OPERATION === "cleanup" ? !production && /^[a-f0-9]{40}$/.test(cleanupSource ?? "") : cleanupSource === null, "cleanup requires an exact Development intent source; other operations cannot select an older source.");
    check(env.WORKER_URL === (production ? "https://forever-tee-api.socialqueue.workers.dev" : "https://forever-tee-api-development.socialqueue.workers.dev"), "fixed API origin required.");
    return { environment, cleanupSource, sourceCommit: qualifiedSource ?? env.GITHUB_SHA, toolingCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, releaseId: env.COMPOSITION_NATIVE_RELEASE, operation: env.COMPOSITION_OPERATION,
        database: production ? protectedConfig("resource_1a1378f0d1dc") : protectedConfig("resource_fb377032d2f5"),
        worker: production ? "forever-tee-api" : "forever-tee-api-development", backup: production ? "forever-tee-story-video" : "forever-tee-story-video-development",
        bucket: `forever-tee-design-artwork-${environment}`, videoBucket: `forever-tee-story-videos-${environment}` };
}
export function verifyCompositionBaseline(context, control, version, backup, backupVersion, verified, fallback) {
    check(control?.paused === 0 && control.release_id === null && control.current_release_id === context.releaseId, "exact unpaused release required.");
    const bindings = version.resources?.bindings;
    const binding = name => bindings?.filter(b => b.name === name);
    for (const [name, text] of Object.entries({ STORY_VIDEO_PROVIDER: "lambda", STORY_VIDEO_RELEASE_ID: context.releaseId, STORY_VIDEO_RELEASE_COMMIT: context.sourceCommit })) {
        const matches = binding(name);
        check(matches?.length === 1 && matches[0].type === "plain_text" && matches[0].text === text, "native code/release binding mismatch.");
    }
    check(backup?.schemaVersion === 1 && backup.environment === context.environment && backup.sourceCommit === context.sourceCommit &&
        backup.qualified === true && backup.cleaned === true && backup.contract === "two-source-v2" && backup.workerVersion === backupVersion, "live qualified compatible backup required.");
    if (context.environment === "production") {
        check(verified?.rollbackRehearsed === true && verified.sourceCommit === context.sourceCommit && verified.provider === "lambda" &&
            verified.native?.workerVersion === version.id && fallback?.workerVersion === verified.fallback?.workerVersion && fallback.provider === "cloudflare" &&
            /^[a-f0-9]{64}$/.test(fallback.content?.sha256 ?? "") && fallback.content.sha256 === verified.native.content?.sha256, "retained compatible rehearsed fallback required before creating new identities.");
    }
}
export function verifyCompositionMedia(manifest, snapshot, { firstAttempt = false } = {}) {
    check(snapshot?.committed === true && snapshot.videos?.length === 4 && snapshot.assets?.length > 0, "complete composition and print assets required.");
    check(snapshot.readiness?.length === 2 && snapshot.readiness.every(value => value?.ready === true), "both products must satisfy the application's complete purchase-readiness check.");
    const expected = new Map(manifest.jobs.map(job => [job.id, job]));
    check(new Set(snapshot.videos.map(job => job.id)).size === 4 && snapshot.videos.every(job => {
        const input = expected.get(job.id), meta = job.object?.metadata;
        return input && input.productId === job.product_id && input.colour === job.colour && job.status === "ready" && job.execution_id &&
            Number.isInteger(job.attempt_count) && job.attempt_count >= 1 && job.attempt_count <= (firstAttempt ? 1 : 3) &&
            job.object?.size === job.output_byte_size && job.output_byte_size > 0 && meta?.jobId === job.id &&
            meta.sourceSha256 === manifest.sources[0].sha256 && meta.recursiveSourceSha256 === manifest.sources[1].sha256 &&
            meta.compositionVersion === "two-source-v2" && meta.rendererVersion === "story-video-renderer-v7" && /^[a-f0-9]{64}$/.test(meta.sha256 ?? "");
    }), "all four videos must match the immutable two-source job and successful fenced attempt.");
    check(manifest.products.every(p => snapshot.assets.some(a => a.configured_product_id === p.id)) && snapshot.assets.every(a => a.status === "ready" && a.width_px > 0 && a.height_px > 0 && /^[a-f0-9]{64}$/.test(a.sha256 ?? "") && typeof a.storage_key === "string"), "ready print geometries for both products required.");
}
export function verifyCompositionPrintResolution(manifest, geometries) {
    const source = manifest.sources.find(source => source.role === "outer");
    check(source, "outer source required for print preflight.");
    return geometries.flatMap(product => product.rows.map(geometry => {
        const result = printSourceResolution(source.width, source.height, { width: geometry.print_width, height: geometry.print_height }, source.crop);
        check(result.safe, `${geometry.geometry_key} is ${result.ppi.toFixed(2)} PPI, below the application's minimum; no composition has been created.`);
        return { productId: product.productId, geometry: geometry.geometry_key, ppi: result.ppi };
    }));
}
export function verifyCompositionCleanupIntent(context, intent, before) {
    check(context.operation === "cleanup" && context.environment === "development" && intent?.schemaVersion === 1 &&
        intent.environment === "development" && intent.operation === "create" && intent.sourceCommit === context.cleanupSource &&
        intent.releaseId === context.releaseId && /^[1-9][0-9]+$/.test(intent.runId ?? "") &&
        ["database", "worker", "backup", "bucket", "videoBucket"].every(key => intent[key] === context[key]) &&
        isDeepStrictEqual(intent.before, before), "cleanup must match the original Development intent and unchanged live pair.");
    check(intent.manifest?.approval === "Synthetic Preview fixture; no customer artwork copied." &&
        !intent.manifest.original && !intent.manifest.transfer, "only the saved synthetic fixture can be cleaned.");
}
