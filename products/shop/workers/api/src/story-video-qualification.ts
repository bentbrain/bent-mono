import { protectedConfig } from "./protected-config";
// Cloud fault injection is confined to CI-created Development fixtures. There
// is no HTTP control endpoint, production binding, or renderer-secret export.
interface QualificationEnv {
    readonly DB: D1Database;
    readonly STORY_VIDEO_PROVIDER?: string;
    readonly STORY_VIDEO_ENVIRONMENT?: string;
    readonly STORY_VIDEO_LAMBDA_FUNCTION?: string;
}
type FaultPoint = "invoke-ack" | "invoke-duplicate" | "claim-ack" | "upload-ack" | "enqueue-send" | "direct-dispatch" | "terminate";
const fixtureKey = /^designs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/artwork\/[0-9a-f]{64}$/;
function qualificationEnvironment(env: QualificationEnv) {
    return env.STORY_VIDEO_PROVIDER === "lambda" && env.STORY_VIDEO_ENVIRONMENT === "development" &&
        env.STORY_VIDEO_LAMBDA_FUNCTION === "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development";
}
export async function takeQualificationFault(env: QualificationEnv, artworkKey: string, jobId: string, point: FaultPoint) {
    if (!qualificationEnvironment(env))
        return false;
    const designId = fixtureKey.exec(artworkKey)?.[1];
    if (!designId)
        return false;
    const now = Date.now();
    try {
        const result = await env.DB.prepare(`UPDATE native_video_qualification_faults SET consumed_at = ?, job_id = ?
      WHERE design_id = ? AND point = ? AND consumed_at IS NULL AND job_id IS NULL
        AND created_at <= ? AND expires_at > ? AND expires_at <= created_at + 600000
        AND release_id = (SELECT current_release_id FROM native_video_release_control WHERE singleton = 1 AND paused = 0)
        AND EXISTS (SELECT 1 FROM story_video_jobs jobs JOIN design_revisions revisions ON revisions.id = jobs.design_revision_id
          JOIN products ON products.id = jobs.product_id AND products.design_revision_id = revisions.id AND products.design_id = revisions.design_id
          WHERE jobs.id = ? AND jobs.attempt_count <= 1 AND products.status = 'active'
            AND revisions.design_id = ? AND revisions.artwork_key = ?)`)
            .bind(now, jobId, designId, point, now, now, jobId, designId, artworkKey).run();
        return result.meta.changes === 1;
    }
    catch {
        // A missing/failed test table must not interrupt real work. Qualification
        // requires the consumed record and observations, so this cannot pass a test.
        return false;
    }
}
export async function observeQualification(env: QualificationEnv, artworkKey: string, jobId: string, stage: "invoke" | "duplicate-invoke" | "claim" | "upload-committed" | "termination-issued", status: number, executionId: string | null = null) {
    if (!qualificationEnvironment(env))
        return;
    const designId = fixtureKey.exec(artworkKey)?.[1];
    if (!designId)
        return;
    const now = Date.now();
    try {
        await env.DB.prepare(`INSERT INTO native_video_qualification_observations
      (id, design_id, job_id, stage, status, execution_id, observed_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM native_video_qualification_faults
        WHERE design_id = ? AND job_id = ? AND consumed_at IS NOT NULL AND created_at <= ? AND expires_at > ?
          AND release_id = (SELECT current_release_id FROM native_video_release_control WHERE singleton = 1 AND paused = 0))`)
            .bind(crypto.randomUUID(), designId, jobId, stage, status, executionId, now, designId, jobId, now, now).run();
    }
    catch { /* Missing evidence fails qualification, never the render itself. */ }
}
export function qualificationLambdaSend(env: QualificationEnv, artworkKey: string, jobId: string, send: typeof fetch): typeof fetch {
    if (!qualificationEnvironment(env) || !fixtureKey.test(artworkKey))
        return send;
    return async (input, init) => {
        const loseAck = await takeQualificationFault(env, artworkKey, jobId, "invoke-ack");
        const duplicate = await takeQualificationFault(env, artworkKey, jobId, "invoke-duplicate");
        const copy = duplicate && input instanceof Request ? input.clone() : undefined;
        const response = await send(input, init);
        if (loseAck || duplicate)
            await observeQualification(env, artworkKey, jobId, "invoke", response.status);
        if (response.status === 202 && !response.headers.has("x-amz-function-error")) {
            if (duplicate && copy) {
                const second = await send(copy, init);
                await observeQualification(env, artworkKey, jobId, "duplicate-invoke", second.status);
                await second.body?.cancel();
            }
            if (loseAck) {
                await response.body?.cancel();
                throw new Error("Qualification discarded the successful AWS acknowledgement.");
            }
        }
        return response;
    };
}
export async function takeQualificationEnqueueFault(env: QualificationEnv, revisionId: string) {
    if (!qualificationEnvironment(env))
        return false;
    const job = await env.DB.prepare(`SELECT jobs.id, revisions.artwork_key FROM story_video_jobs jobs
    JOIN design_revisions revisions ON revisions.id = jobs.design_revision_id
    WHERE jobs.design_revision_id = ? AND jobs.attempt_count = 0 ORDER BY jobs.id LIMIT 1`)
        .bind(revisionId).first<{
        id: string;
        artwork_key: string;
    }>();
    return job ? takeQualificationFault(env, job.artwork_key, job.id, "enqueue-send") : false;
}
