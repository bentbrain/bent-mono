import { describe, expect, test } from "bun:test";
import { SignedOutError, createApi } from "../src/data/api";

/** A session whose generation the test moves, as a sign-out or sign-in does. */
function session() {
  const state = { generation: 1, tokens: 0 };
  return {
    state,
    source: {
      token: async ({ generation }: { generation?: number } = {}) => {
        if (generation !== undefined && generation !== state.generation) throw new Error("expired");
        return `token-${state.generation}-${++state.tokens}`;
      },
      invalidate: () => undefined,
      generation: () => state.generation,
    },
  };
}

describe("app API client", () => {
  test("a 401 refreshes the token once and tries again under the same sign-in", async () => {
    const { source } = session();
    const seen: string[] = [];
    const api = createApi("https://fitness.example", source, async (_url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(auth);
      return seen.length === 1
        ? Response.json({ error: "Sign in to Fitness again.", code: "unauthorized" }, { status: 401 })
        : Response.json({ owner: "user_a", records: [] });
    });
    expect((await api.loadRecords()).owner).toBe("user_a");
    expect(seen).toEqual(["Bearer token-1-1", "Bearer token-1-2"]);
  });

  test("a reply that arrives after the sign-in changed is not used or retried", async () => {
    const { source, state } = session();
    const seen: string[] = [];
    const api = createApi("https://fitness.example", source, async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      // Another account signs in while this request is in flight.
      state.generation = 2;
      return Response.json({ error: "Sign in to Fitness again.", code: "unauthorized" }, { status: 401 });
    });
    await expect(
      api.saveRecord({ id: crypto.randomUUID(), revision: 0, operationId: crypto.randomUUID(), data: null }),
    ).rejects.toBeInstanceOf(SignedOutError);
    expect(seen).toEqual(["Bearer token-1-1"]);
  });

  test("a reply whose body arrives after the sign-in changed is not returned", async () => {
    const { source, state } = session();
    const api = createApi("https://fitness.example", source, async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // The body finishes only after another account signed in.
          setTimeout(() => {
            state.generation = 2;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ owner: "user_a", records: [] })));
            controller.close();
          }, 5);
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    });
    await expect(api.loadRecords()).rejects.toBeInstanceOf(SignedOutError);
  });
});
