import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Run the pinned SDK's real HTTP proxy/stream accounting in Node. Only its
// platform imports and constructor storage are replaced, not containerFetch.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "data:text/javascript,export class DurableObject {} export class WorkerEntrypoint {}" };
    }
    if (context.parentURL?.includes("/@cloudflare/containers/") && specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { StoryVideoContainer } = await import("./worker.mjs");
hooks.deregister();
globalThis.IdentityTransformStream = TransformStream;

function fixture(status = 200) {
  const pending = [];
  const controller = Object.create(StoryVideoContainer.prototype);
  Object.assign(controller, {
    defaultPort: 8080, sleepAfter: "30s", sleepAfterMs: 0, inflightRequests: 0,
    state: { getState: async () => ({ status: "healthy" }) },
    ctx: { waitUntil: (promise) => pending.push(promise) },
    container: {
      running: true,
      getTcpPort: () => ({ fetch: async () => {
        const response = Response.json({ ok: status === 200 }, { status });
        response.webSocket = null;
        return response;
      } }),
    },
  });
  return { controller, pending };
}

for (const path of ["/health", "/render-stored"]) {
  for (const status of [200, 500]) {
    test(`${path} ${status}: abandoning the response cannot keep the container alive`, async () => {
      const { controller, pending } = fixture(status);
      const response = await controller.fetch(new Request(`https://container.internal${path}`));
      // Upstream is gone. Do not consume the returned body until after the
      // shutdown invariant. With the SDK alone its pipe stays backpressured.
      await Promise.all(pending);
      await new Promise(setImmediate);
      try {
        assert.equal(controller.inflightRequests, 0);
        assert.equal(response.status, status);
      } finally { await response.arrayBuffer(); }
    });
  }
}
