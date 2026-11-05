import { diagnosticRequestId, diagnosticRoute, safeErrorDetails } from "@forever-tee/contracts/diagnostics";

import { safePrintifyOrderDatabaseDetails } from "./printify-order-diagnostics";

interface ReleaseContext {
  readonly OPERATIONS_ENVIRONMENT?: string;
  readonly STORY_VIDEO_RELEASE_ID?: string;
  readonly STORY_VIDEO_RELEASE_COMMIT?: string;
}

function releaseContext(env: ReleaseContext) {
  return {
    environment: ["development", "production"].includes(env.OPERATIONS_ENVIRONMENT ?? "")
      ? env.OPERATIONS_ENVIRONMENT : "local",
    releaseId: /^native-\d+$/.test(env.STORY_VIDEO_RELEASE_ID ?? "") ? env.STORY_VIDEO_RELEASE_ID : undefined,
    sourceCommit: /^[a-f0-9]{40}$/.test(env.STORY_VIDEO_RELEASE_COMMIT ?? "") ? env.STORY_VIDEO_RELEASE_COMMIT : undefined,
  };
}

// Workers Issues also captures uncaught exceptions independently of log
// settings. Preserve a rejected invocation without forwarding private messages,
// causes or arbitrary exception properties to the platform.
export function diagnosticRuntimeError(error: unknown, reference: string): Error {
  const details = safeErrorDetails(error);
  const failure = new Error(`Application execution failed. Diagnostic reference: ${reference}`);
  failure.name = details.errorType;
  failure.stack = `${failure.name}: ${failure.message}${details.stackFrames.map(frame => `\n    at ${frame}`).join("")}`;
  return failure;
}

export async function observeApiRequest(
  request: Request,
  env: ReleaseContext,
  handle: (request: Request) => Promise<Response>,
): Promise<Response> {
  const requestId = diagnosticRequestId(request.headers.get("x-request-id"))
    ?? diagnosticRequestId(request.headers.get("cf-ray")) ?? crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  const startedAt = performance.now();
  const path = new URL(request.url).pathname;
  // Obsolete capability-bearing paths are rejected without processing. Do not
  // emit a console record: the platform enriches it with the original URL.
  const obsoleteUploadPath = path.startsWith("/v2/design-upload-grants/");
  const metadata = {
    ...releaseContext(env), requestId, method: request.method,
    route: diagnosticRoute(path),
  };
  try {
    const response = await handle(new Request(request, { headers: requestHeaders }));
    const record = { ...metadata, durationMs: Math.round(performance.now() - startedAt), status: response.status };
    if (!obsoleteUploadPath) {
      if (response.status >= 500) console.error("bent.shop API request", record);
      else if (response.status >= 400) console.warn("bent.shop API request", record);
      else console.info("bent.shop API request", record);
    }
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
  } catch (error) {
    console.error("bent.shop API request failed", {
      ...metadata, durationMs: Math.round(performance.now() - startedAt),
      ...safeErrorDetails(error),
    });
    throw diagnosticRuntimeError(error, requestId);
  }
}

export async function observeBackgroundTask<T>(
  operation: string,
  env: ReleaseContext,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const metadata = { ...releaseContext(env), operation, executionId: crypto.randomUUID() };
  try {
    const result = await run();
    console.info("bent.shop background task", { ...metadata, durationMs: Math.round(performance.now() - startedAt), outcome: "completed" });
    return result;
  } catch (error) {
    console.error("bent.shop background task failed", { ...metadata,
      durationMs: Math.round(performance.now() - startedAt), ...safeErrorDetails(error),
      ...safePrintifyOrderDatabaseDetails(error),
    });
    throw diagnosticRuntimeError(error, metadata.executionId);
  }
}
