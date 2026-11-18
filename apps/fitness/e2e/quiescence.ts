import { expect } from "@playwright/test";
import type { BrowserContext, Request } from "@playwright/test";

const writes = new WeakMap<BrowserContext, Set<Request>>();

/** Tracks account writes sent from any page in the context. */
export function trackWrites(context: BrowserContext) {
  const pending = new Set<Request>();
  writes.set(context, pending);
  context.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/_serverFn/"))
      pending.add(request);
  });
  const settled = (request: Request) => pending.delete(request);
  context.on("requestfinished", settled);
  context.on("requestfailed", settled);
}

/**
 * Waits until no account write is in flight. Synthetic account cleanup runs
 * before the next test, so it must not race a save the server is still
 * committing.
 */
export async function settleWrites(context: BrowserContext) {
  const pending = writes.get(context);
  if (pending)
    await expect.poll(() => pending.size, { timeout: 20000 }).toBe(0);
}
