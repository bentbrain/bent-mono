import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
export const BACKUP_ACCOUNT = protectedConfig("cloudflareAccountId");
const check = (value, reason) => { if (!value)
    throw Error(`Backup renderer release stopped: ${reason}`); };
export const backupHash = bytes => createHash("sha256").update(bytes).digest("hex");
export function backupContext(env) {
    check(env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted" &&
        env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") && env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") &&
        env.GITHUB_REPOSITORY === "bentbrain/bent-mono" && env.GITHUB_ACTOR_ID === protectedConfig("githubOwnerId") &&
        env.GITHUB_REF === "refs/heads/main" && env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
        env.GITHUB_RUN_ATTEMPT === "1" && /^[1-9][0-9]+$/.test(env.GITHUB_RUN_ID ?? "") &&
        /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") &&
        env.GITHUB_WORKFLOW_REF === "bentbrain/bent-mono/.github/workflows/backup-renderer.yml@refs/heads/main", "first-attempt owner dispatch on main in the personal repository required.");
    check(["development", "production"].includes(env.BACKUP_ENVIRONMENT) &&
        env.CLOUDFLARE_ACCOUNT_ID === BACKUP_ACCOUNT && env.CLOUDFLARE_API_TOKEN && env.RUNNER_TEMP?.startsWith("/"), "protected personal environment required.");
    const environment = env.BACKUP_ENVIRONMENT;
    const productionRecovery = environment === "production" && env.BACKUP_OPERATION === "recover";
    const sourceCommit = productionRecovery ? env.BACKUP_RECOVERY_SOURCE : env.GITHUB_SHA;
    check(/^[a-f0-9]{40}$/.test(sourceCommit ?? ""), "exact original recovery source required.");
    return { environment, sourceCommit, toolingCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
        worker: environment === "production" ? "forever-tee-story-video" : "forever-tee-story-video-development",
        api: environment === "production" ? "forever-tee-api" : "forever-tee-api-development",
        database: environment === "production" ? protectedConfig("resource_1a1378f0d1dc") : protectedConfig("resource_fb377032d2f5"),
        containerId: environment === "production" ? protectedConfig("resource_e435a8e418a8") : protectedConfig("resource_6e6477090232"),
        bucket: `forever-tee-design-artwork-${environment}`,
        videoBucket: `forever-tee-story-videos-${environment}`,
        receiptKey: `editorial/backup/${sourceCommit}/${environment}.json`,
        intentKey: `editorial/backup/${env.GITHUB_SHA}/${environment}${productionRecovery ? "-recovery" : ""}-intent.json` };
}
export function assertInactiveBackup(settings, controls, compositions) {
    const providers = settings.bindings?.filter(binding => binding.name === "STORY_VIDEO_PROVIDER");
    check(providers?.length === 1 && providers[0].type === "plain_text" && providers[0].text === "lambda", "the backup must be inactive behind the native provider.");
    check(controls.length === 1 && controls[0].paused === 0 && controls[0].release_id === null &&
        /^native-[1-9][0-9]+$/.test(controls[0].current_release_id ?? ""), "unpaused native baseline required.");
    check(compositions.length === 1 && compositions[0].count === 0, "this compatibility bootstrap cannot run after composed products exist.");
}
export function assertBackupReceipt(receipt, sourceCommit) {
    check(receipt?.schemaVersion === 1 && receipt.environment === "development" && receipt.sourceCommit === sourceCommit &&
        receipt.qualified === true && receipt.cleaned === true && receipt.contract === "two-source-v2" &&
        /^[1-9][0-9]+$/.test(receipt.runId ?? "") &&
        new RegExp(`^registry\\.cloudflare\\.com/${BACKUP_ACCOUNT}/featured-backup@sha256:[a-f0-9]{64}$`).test(receipt.image ?? "") &&
        /^[a-f0-9]{64}$/.test(receipt.bundleSha256 ?? "") && /^[a-f0-9-]{36}$/.test(receipt.workerVersion ?? "") &&
        Array.isArray(receipt.frames) && receipt.frames.length === 3 &&
        receipt.frames.every(frame => Number.isFinite(frame.rmse) && frame.rmse < 6), "qualified exact-source Preview backup receipt required.");
    return receipt;
}
export function backupRecoverySource(env, context) {
    const operation = env.BACKUP_OPERATION || "deploy";
    const source = env.BACKUP_RECOVERY_SOURCE || "";
    check(["deploy", "recover"].includes(operation), "known backup operation required.");
    if (operation === "deploy") {
        check(source === "", "deployment cannot take a recovery source.");
        return null;
    }
    check(/^[a-f0-9]{40}$/.test(source) && source !== context.toolingCommit, "Recovery requires the original deployment commit and distinct tooling commit.");
    return source;
}
export function assertBackupRecovery(intent, context, source, live, nativeBefore) {
    check(intent?.schemaVersion === 1 && intent.sourceCommit === source &&
        /^[1-9][0-9]+$/.test(intent.runId ?? "") && !intent.recovery, "original deployment intent required.");
    for (const field of ["environment", "worker", "api", "database", "containerId", "bucket", "videoBucket"]) {
        check(intent[field] === context[field], `recovery ${field} differs.`);
    }
    check(intent.intentKey === `editorial/backup/${source}/${context.environment}-intent.json` &&
        intent.receiptKey === `editorial/backup/${source}/${context.environment}.json`, "original evidence keys required.");
    check(new RegExp(`^registry\\.cloudflare\\.com/${BACKUP_ACCOUNT}/featured-backup@sha256:[a-f0-9]{64}$`).test(intent.image ?? "") &&
        /^[a-f0-9]{64}$/.test(intent.bundleSha256 ?? ""), "immutable original image and bundle required.");
    check(live.container.id === context.containerId && live.container.image === intent.image &&
        live.workerVersion !== intent.before?.workerVersion && live.container.version === intent.before?.container?.version + 1, "recovery requires the completed original deployment, never a replacement.");
    check(JSON.stringify(nativeBefore) === JSON.stringify(intent.nativeBefore), "native baseline changed since original intent.");
    return intent;
}
