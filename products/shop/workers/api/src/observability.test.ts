import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { PrintifyOrderDatabaseError, safeD1ErrorDetails } from "./printify-order-diagnostics";
import { diagnosticRoute, safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { observeApiRequest, observeBackgroundTask } from "./observability";

afterEach(() => vi.restoreAllMocks());

describe("launch request observability", () => {
  it("correlates early webhook responses without logging customer values", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await observeApiRequest(new Request("https://api.test/v2/webhooks/shopify/customer-secret?token=private", {
      method: "POST", headers: { "x-request-id": "launch-request-1", authorization: "private" }, body: "private portrait",
    }), { OPERATIONS_ENVIRONMENT: "production" }, async request => {
      expect(request.headers.get("x-request-id")).toBe("launch-request-1");
      expect(await request.text()).toBe("private portrait");
      return new Response("upstream failure", { status: 503, headers: { "Retry-After": "60" } });
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe("launch-request-1");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toBe("upstream failure");
    expect(log).toHaveBeenCalledWith("bent.shop API request", expect.objectContaining({
      environment: "production", requestId: "launch-request-1", route: "/v2/webhooks/shopify/[id]", status: 503,
    }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|customer-secret|portrait|authorization/);
  });

  it("keeps rejected requests distinct from server failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await observeApiRequest(new Request("https://api.test/v2/design-drafts/private-draft", {
      headers: { "x-request-id": "invalid request id", "cf-ray": "0123456789abcdef-BNE" },
    }), {}, () => Promise.resolve(new Response(null, { status: 429 })));
    expect(response.headers.get("x-request-id")).toBe("0123456789abcdef-BNE");
    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("capability");
  });

  it("records a safe stack and preserves thrown failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new TypeError("customer@example.com token=private");
    failure.stack = "TypeError: customer@example.com token=private\n    at execute (/Users/example/repo/workers/api/src/index.ts:50:2)\n    at remote (https://private.example/image?token=private:1:2)";
    failure.cause = new Error("PRIVATE_CAUSE");
    const rejected = observeApiRequest(new Request("https://api.test/v2/internal/sales-intake", {
      headers: { "x-request-id": "launch-safe-exception" },
    }), {}, () => Promise.reject(failure));
    await expect(rejected).rejects.toMatchObject({ name: "TypeError",
      message: "Application execution failed. Diagnostic reference: launch-safe-exception",
      stack: "TypeError: Application execution failed. Diagnostic reference: launch-safe-exception\n    at /src/index.ts:50:2",
    });
    await expect(rejected).rejects.not.toHaveProperty("cause");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|customer@example|token=/);
    expect(log).toHaveBeenCalledWith("bent.shop API request failed", expect.objectContaining({
      errorType: "TypeError", stackFrames: ["/src/index.ts:50:2"],
    }));
  });

  it("does not enrich obsolete capability paths with platform console metadata", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await observeApiRequest(new Request("https://api.test/v2/design-upload-grants/private-capability"), {},
      () => Promise.resolve(new Response(null, { status: 410 })));
    expect(response.status).toBe(410);
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("records task failures without swallowing queue retry signals", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("private provider body");
    await expect(observeBackgroundTask("printify_order_submission", {}, () => Promise.reject(failure)))
      .rejects.toThrow(/^Application execution failed\. Diagnostic reference: [a-f0-9-]{36}$/);
    expect(log).toHaveBeenCalledWith("bent.shop background task failed", expect.objectContaining({ operation: "printify_order_submission", errorType: "Error" }));
    const record: unknown = log.mock.calls[0]?.[1];
    expect(typeof record === "object" && record !== null && "executionId" in record && typeof record.executionId === "string").toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider body");
  });

  it.each([
    { _tag: "PrintifyOrderDatabaseError", operation: "fence expired Printify order mutations", diagnostic: { databaseErrorCode: "PRIVATE_CODE", databaseErrorCategory: "PRIVATE_CATEGORY" } },
    new PrintifyOrderDatabaseError({ operation: "PRIVATE_OPERATION", diagnostic: safeD1ErrorDetails({ code: "SQLITE_BUSY" }) }),
    new PrintifyOrderDatabaseError({ operation: "parse locked delivery address" }),
  ])("does not treat arbitrary failures or non-D1 operations as database diagnostics", async failure => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const observed = observeBackgroundTask("printify_order_submission", {}, () => Effect.runPromise(Effect.fail(failure)));
    await expect(observed).rejects.toThrow("Application execution failed.");
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toMatch(/PRIVATE_|databaseOperation|databaseErrorCode|databaseErrorCategory/);
  });

  it("keeps safe route groups and rejects arbitrary error names", () => {
    expect(diagnosticRoute("/manage-order/private-token?email=secret#secret")).toBe("/manage-order/[id]");
    const error = new Error("private");
    error.name = "customer@example.com";
    expect(safeErrorDetails(error).errorType).toBe("UnknownError");
  });

  it("retains built Worker locations without arbitrary path or URL metadata", () => {
    const error = new Error("PRIVATE_MESSAGE");
    error.stack = "Error: PRIVATE_MESSAGE\n    at execute (index.js:500:20)\n    at remote (https://private.example/index.js:1:2)\n    at dynamic (private-capability.js:3:4)";
    expect(safeErrorDetails(error)).toEqual({ errorType: "Error", stackFrames: ["index.js:500:20"] });
  });
});
