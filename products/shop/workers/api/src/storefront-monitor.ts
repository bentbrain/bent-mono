import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";

const PRODUCTION_PAGES = ["https://shop.bent.build/", "https://shop.bent.build/create"];

// Public availability only. Never creates a draft, cart, checkout or order.
export async function checkStorefrontAvailability(environment?: string) {
  if (environment !== "production") return;
  await Promise.all(PRODUCTION_PAGES.map(async url => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    const route = new URL(url).pathname;
    try {
      const response = await fetch(url, {
        method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: { "x-request-id": requestId },
      });
      const record = { operation: "storefront_availability", route, requestId,
        status: response.status, durationMs: Math.round(performance.now() - startedAt) };
      if (response.status !== 200) console.error("bent.shop storefront unavailable", record);
      else console.info("bent.shop storefront availability", record);
    } catch (error) {
      console.error("bent.shop storefront probe failed", {
        operation: "storefront_availability", route, requestId,
        durationMs: Math.round(performance.now() - startedAt), ...safeErrorDetails(error),
      });
    }
  }));
}
