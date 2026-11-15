import { canonicalNativeServingTarget, parseNativeServingTarget, type NativeServingTarget, type NativeServingPins } from "@forever-tee/contracts/native-serving-target";
import { protectedConfig } from "./protected-config";

export interface NativeServingEnv {
    readonly SHOP_NATIVE_SERVING_TARGET_JSON?: string;
    readonly STORY_VIDEO_ENVIRONMENT?: string;
    readonly OPERATIONS_ENVIRONMENT?: string;
}
export function nativeServingPins(env: NativeServingEnv): NativeServingPins {
    const environment = env.STORY_VIDEO_ENVIRONMENT;
    if ((environment !== "development" && environment !== "production") ||
        (env.OPERATIONS_ENVIRONMENT !== undefined && env.OPERATIONS_ENVIRONMENT !== environment))
        throw new Error("Native serving target must match the installed business environment.");
    const mainFunctionArn = protectedConfig("nativeServingFunctionArn"), failureFunctionArn = protectedConfig("nativeServingFailureFunctionArn");
    const prefix = `arn:aws:lambda:ap-southeast-2:${protectedConfig("awsAccountId")}:function:`;
    if (!mainFunctionArn.startsWith(prefix) || !failureFunctionArn.startsWith(prefix)) throw new Error("Native serving resource account differs from protected configuration.");
    return { environment, mainFunctionArn, failureFunctionArn };
}
export function installedNativeServingTarget(env: NativeServingEnv): NativeServingTarget | undefined {
    return env.SHOP_NATIVE_SERVING_TARGET_JSON === undefined ? undefined : parseNativeServingTarget(env.SHOP_NATIVE_SERVING_TARGET_JSON, nativeServingPins(env));
}
function retainedNativeServingIdentity(env: NativeServingEnv, serialized: string) {
    return parseNativeServingTarget(serialized, nativeServingPins(env));
}
async function identityDigest(value: string) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export type NativeServingJobKind = "video" | "image-v4";
interface ServingAcceptanceRow { readonly target_json: string; readonly target_digest: string; readonly attempt: number }
export interface NativeServingAcceptance {
    readonly kind: NativeServingJobKind;
    readonly jobId: string;
    readonly attempt: number;
    readonly target: NativeServingTarget;
    readonly targetJSON: string;
    readonly targetDigest: string;
}
export async function prepareNativeServingAcceptance(db: D1Database, env: NativeServingEnv, kind: NativeServingJobKind, jobId: string, attempt: number): Promise<NativeServingAcceptance | undefined> {
    const current = installedNativeServingTarget(env);
    const schema = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='native_serving_dispatches'").first();
    if (!schema) {
        if (current) throw new Error("Install the retained native serving dispatch schema before promotion.");
        return undefined;
    }
    const previous = await db.prepare("SELECT target_json,target_digest,attempt FROM native_serving_dispatches WHERE kind=? AND job_id=? ORDER BY attempt DESC LIMIT 1")
        .bind(kind, jobId).first<ServingAcceptanceRow>();
    let target = current;
    if (previous) {
        target = retainedNativeServingIdentity(env, previous.target_json);
        if (canonicalNativeServingTarget(target) !== previous.target_json || await identityDigest(previous.target_json) !== previous.target_digest)
            throw new Error("Retained native serving identity changed.");
    }
    if (!target) return undefined;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3 || (attempt > 1 && !previous))
        throw new Error("Drain legacy attempts without retained native serving identity before promotion.");
    const targetJSON = canonicalNativeServingTarget(target);
    return { kind, jobId, attempt, target, targetJSON, targetDigest: await identityDigest(targetJSON) };
}
export function nativeServingAcceptanceStatement(db: D1Database, acceptance: NativeServingAcceptance, now: number) {
    const source = acceptance.kind === "video" ? "story_video_jobs" : "product_image_jobs";
    return db.prepare(`INSERT INTO native_serving_dispatches(kind,job_id,attempt,target_json,target_digest,accepted_at)
      SELECT ?,?,?,?,?,? FROM ${source} WHERE id=? AND attempt_count=? AND status='rendering'
      ON CONFLICT(kind,job_id,attempt) DO NOTHING`)
        .bind(acceptance.kind, acceptance.jobId, acceptance.attempt, acceptance.targetJSON, acceptance.targetDigest, now, acceptance.jobId, acceptance.attempt);
}
export async function verifyNativeServingAcceptance(db: D1Database, acceptance: NativeServingAcceptance) {
    const row = await db.prepare("SELECT target_json,target_digest,attempt FROM native_serving_dispatches WHERE kind=? AND job_id=? AND attempt=?")
        .bind(acceptance.kind, acceptance.jobId, acceptance.attempt).first<ServingAcceptanceRow>();
    if (row?.target_json !== acceptance.targetJSON || row.target_digest !== acceptance.targetDigest || await identityDigest(row.target_json) !== row.target_digest)
        throw new Error("Native serving acceptance did not commit before invocation.");
    return acceptance.target;
}

export async function assertNativeServingAdmission(db: D1Database, env: NativeServingEnv, now: number) {
    if (!installedNativeServingTarget(env)) return;
    if (!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='native_serving_dispatches'").first())
        throw new Error("Install the retained native serving dispatch schema before promotion.");
    const legacy = await db.prepare(`SELECT jobs.id FROM story_video_jobs jobs
      WHERE NOT EXISTS(SELECT 1 FROM native_serving_dispatches accepted WHERE accepted.kind='video' AND accepted.job_id=jobs.id)
      AND (jobs.status='rendering' OR (jobs.status IN ('queued','failed') AND jobs.attempt_count>0 AND jobs.attempt_count<3)
        OR (jobs.execution_id IS NOT NULL AND jobs.updated_at>?)) LIMIT 1`).bind(now - 40000).first();
    if (legacy) throw new Error("Drain legacy video work without retained native serving identity before promotion.");
}
