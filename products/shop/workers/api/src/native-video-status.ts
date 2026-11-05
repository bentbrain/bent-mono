import { isAuthenticatedOperationsRequest } from "./service-auth";
import { validateLambdaStoryVideoEnv, type LambdaStoryVideoEnv } from "./story-video-lambda";
import { STORY_VIDEO_RENDERER_VERSION } from "./story-video-jobs";

interface NativeVideoStatusEnv extends LambdaStoryVideoEnv {
  readonly DB: D1Database;
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
  readonly STORY_VIDEO_RELEASE_ID?: string;
  readonly STORY_VIDEO_RELEASE_COMMIT?: string;
  readonly STORY_VIDEO_IMAGE_DIGEST?: string;
  readonly STORY_VIDEO_SOURCE_DIGEST?: string;
}

// Read-only operational evidence. It never changes admissions, job state,
// credentials or deployment configuration, and never returns secret values.
export async function handleNativeVideoStatus(request: Request, env: NativeVideoStatusEnv): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/v2/internal/operations/native-video-release") return;
  if (!(await isAuthenticatedOperationsRequest(request, env))) return new Response(null, { status: 401 });
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  try {
    const config = validateLambdaStoryVideoEnv(env);
    if (!/^native-\d+$/.test(env.STORY_VIDEO_RELEASE_ID ?? "") ||
      !/^[a-f0-9]{40}$/.test(env.STORY_VIDEO_RELEASE_COMMIT ?? "") ||
      !/^sha256:[a-f0-9]{64}$/.test(env.STORY_VIDEO_IMAGE_DIGEST ?? "") ||
      !/^[a-f0-9]{64}$/.test(env.STORY_VIDEO_SOURCE_DIGEST ?? "") || !env.STORY_VIDEOS) {
      return new Response(null, { status: 503 });
    }
    const control = await env.DB.prepare(`SELECT paused, release_id, paused_at FROM native_video_release_control WHERE singleton = 1`)
      .first<{ paused: number; release_id: string | null; paused_at: number }>();
    const column = await env.DB.prepare("SELECT name FROM pragma_table_info('story_video_jobs') WHERE name = 'execution_id'").first();
    if (!control || !column) return new Response(null, { status: 503 });
    return Response.json({ executionProtocol: "claim-v1", rendererVersion: STORY_VIDEO_RENDERER_VERSION,
      releaseId: env.STORY_VIDEO_RELEASE_ID, sourceCommit: env.STORY_VIDEO_RELEASE_COMMIT,
      sourceDigest: env.STORY_VIDEO_SOURCE_DIGEST, imageDigest: env.STORY_VIDEO_IMAGE_DIGEST,
      functionArn: config.functionArn, environment: env.STORY_VIDEO_ENVIRONMENT ?? "development",
      paused: control.paused === 1, pauseOwner: control.release_id, pausedAt: control.paused_at,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch { return new Response(null, { status: 503 }); }
}
