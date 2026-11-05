import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestError } from "./instrumentation";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("server error diagnostics", () => {
  it("retains safe request and build context without private capabilities or messages", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new TypeError("customer@example.com private-address");
    error.stack = "TypeError: private\n    at execute (/Users/example/repo/apps/web/src/server/checkout.ts:42:3)";
    await onRequestError(error, { path: "/manage-order/private-capability?email=customer@example.com", method: "POST", headers: { "x-request-id": "launch-request" } }, {
      routerKind: "App Router", routePath: "/manage-order/[token]", routeType: "route", revalidateReason: undefined,
    });
    expect(log).toHaveBeenCalledWith("[bent.shop server] request failed", expect.objectContaining({
      requestId: "launch-request", sourceCommit: "a".repeat(40), requestPath: "/manage-order/[id]", errorType: "TypeError", stackFrames: ["/src/server/checkout.ts:42:3"],
    }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|customer@example|token/);
  });
});
