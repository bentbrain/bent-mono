// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCartDiagnostics } from "./cart-diagnostics";
import { captureClientException, captureStorefrontFailure } from "./posthog";
vi.mock("./posthog", () => ({ captureClientException: vi.fn(), captureStorefrontFailure: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("cart diagnostics", () => {
  it("observes failed settlements without copying customer data or changing the promise", async () => {
    const remove = installCartDiagnostics();
    const result = { cart: null, userErrors: [{ message: "customer@example.com private address", field: ["private-token"] }] };
    const promise = Promise.resolve(result);
    try {
      document.dispatchEvent(Object.assign(new Event("shopify:cart:lines-update"), { promise }));
      expect(await promise).toBe(result);
      expect(captureStorefrontFailure).toHaveBeenCalledWith({ operation: "cart_mutation", code: "CART_REJECTED", status: undefined, requestId: undefined });
      expect(captureClientException).not.toHaveBeenCalled();
    } finally { remove(); }
  });

  it("correlates a dependency rejection with the safe server request ID", async () => {
    const remove = installCartDiagnostics();
    try {
      const promise = Promise.resolve({ userErrors: [{ code: "CART_DEPENDENCY_UNAVAILABLE", message: "private" }], detail: { requestId: "cart-request-1" } });
      document.dispatchEvent(Object.assign(new Event("shopify:cart:lines-update"), { promise }));
      await promise;
      expect(captureStorefrontFailure).toHaveBeenCalledWith({ operation: "cart_mutation", code: "CART_DEPENDENCY_UNAVAILABLE", status: 503, requestId: "cart-request-1" });
    } finally { remove(); }
  });

  it("reports network failures and ignores intentional cancellation", async () => {
    const remove = installCartDiagnostics();
    const error = new TypeError("network failure");
    try {
      const failed = Promise.reject(error);
      document.dispatchEvent(Object.assign(new Event("shopify:cart:lines-update"), { promise: failed }));
      await expect(failed).rejects.toBe(error);
      expect(captureClientException).toHaveBeenCalledWith(error, { operation: "cart_mutation" });
      vi.mocked(captureStorefrontFailure).mockClear();
      const aborted = Promise.reject(new DOMException("Cancelled", "AbortError"));
      document.dispatchEvent(Object.assign(new Event("shopify:cart:lines-update"), { promise: aborted }));
      await expect(aborted).rejects.toThrow();
      expect(captureStorefrontFailure).not.toHaveBeenCalled();
    } finally { remove(); }
  });
});
