import { captureClientException, captureStorefrontFailure } from "./posthog";

// Standard Actions expose the original settlement promise. Observe it without
// replacing the transport or changing mutation ordering and recovery.
export function installCartDiagnostics() {
  const observe = (event: Event) => {
    if (!("promise" in event) || !(event.promise instanceof Promise)) return;
    void event.promise.then((result: unknown) => {
      if (typeof result !== "object" || result === null || !("userErrors" in result)) return;
      if (Array.isArray(result.userErrors) && result.userErrors.length > 0) {
        const dependencyUnavailable = result.userErrors.some((error: unknown) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "CART_DEPENDENCY_UNAVAILABLE");
        const detail = "detail" in result ? result.detail : undefined;
        const requestId = typeof detail === "object" && detail !== null && "requestId" in detail && typeof detail.requestId === "string"
          ? detail.requestId : undefined;
        captureStorefrontFailure({ operation: "cart_mutation", code: dependencyUnavailable ? "CART_DEPENDENCY_UNAVAILABLE" : "CART_REJECTED",
          status: dependencyUnavailable ? 503 : undefined, requestId });
      }
    }, (error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      captureStorefrontFailure({ operation: "cart_mutation", code: "CART_REQUEST_FAILED" });
      if (error instanceof Error) captureClientException(error, { operation: "cart_mutation" });
    });
  };
  const events = ["shopify:cart:lines-update", "shopify:cart:discount-update", "shopify:cart:note-update"];
  for (const event of events) document.addEventListener(event, observe);
  return () => { for (const event of events) document.removeEventListener(event, observe); };
}
