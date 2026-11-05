import { diagnosticRequestId, diagnosticRoute, safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? typeof error.digest === "string" && /^[A-Za-z0-9-]{1,64}$/.test(error.digest) ? error.digest : undefined
      : undefined;

  console.error("[bent.shop server] request failed", {
    digest,
    ...safeErrorDetails(error),
    requestId: diagnosticRequestId(request.headers["x-request-id"]),
    sourceCommit: /^[a-f0-9]{40}$/.test(process.env["VERCEL_GIT_COMMIT_SHA"] ?? "")
      ? process.env["VERCEL_GIT_COMMIT_SHA"] : undefined,
    requestMethod: request.method,
    requestPath: diagnosticRoute(request.path),
    routePath: diagnosticRoute(context.routePath),
    routeType: context.routeType,
    routerKind: context.routerKind,
  });
};
