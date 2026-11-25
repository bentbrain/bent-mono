/**
 * A local server for the iPhone app's Simulator flows. It serves the real
 * Fitness device and import handlers against Postgres, with Clerk replaced
 * by the synthetic fake, and a synthetic OAuth server in place of Clerk's
 * sign-in. The authorize endpoint signs in the synthetic owner at once and
 * redirects to the app with a code; the token endpoint checks the PKCE
 * verifier and redirect URI and issues an access token for the requested
 * resource.
 *
 * It runs only when FITNESS_IOS_SIM_PORT is set, until `POST /__stop`.
 * `GET /__state` lists the records the account holds. Start it with
 * `apps/fitness-ios/scripts/flows.mjs`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { configure, installClerkFake, iosClient, syntheticOwner } from "./clerk-fake";
import { isolatedSchema } from "./isolated-schema";

const fake = installClerkFake();
const port = Number(process.env.FITNESS_IOS_SIM_PORT ?? "0");
const configured = Boolean(port && process.env.FITNESS_TEST_DATABASE_URL);
const isolated = isolatedSchema("fitness_ios_sim");
const origin = `http://127.0.0.1:${port}`;
if (configured) {
  configure(process.env.FITNESS_TEST_DATABASE_URL ?? "");
  process.env.FITNESS_MCP_URL = `${origin}/api/mcp`;
}
const devices = await import("../src/server/devices");
const { handleHealthImport } = await import("../src/server/health");
const { loadRecords, saveRecord } = await import("../src/server/store");
const { defaultSettings, settingsId } = await import("../src/domain");

const redirectUri = "build.bent.fitness.dev://oauth";

beforeAll(async () => {
  if (!configured) return;
  await isolated.create();
  await isolated.pool().unsafe(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
  fake.reset();
  devices.setEnrollmentBudget(1000, 1000);
  devices.setSharedEnrollmentLimit(100_000);
  const today = new Date().toISOString().slice(0, 10);
  await saveRecord(syntheticOwner.id, {
    operationId: crypto.randomUUID(),
    id: settingsId,
    revision: 0,
    data: defaultSettings(today, process.env.FITNESS_IOS_SIM_TIMEZONE ?? "UTC"),
  });
});
afterAll(async () => {
  if (configured) await isolated.drop();
});

type Grant = { challenge: string; redirect: string; resource: string };

test.skipIf(!configured)(
  "serves the Simulator flows until stopped",
  async () => {
    const grants = new Map<string, Grant>();
    let tokens = 0;
    let stop = () => undefined as void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const fail = (status: number, error: string) => Response.json({ error }, { status });

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (request.method === "GET" && path === "/oauth/authorize") {
          const q = url.searchParams;
          if (q.get("client_id") !== iosClient) return fail(400, "unknown client");
          if (q.get("redirect_uri") !== redirectUri) return fail(400, "unregistered redirect URI");
          if (q.get("response_type") !== "code") return fail(400, "response_type must be code");
          if (q.get("code_challenge_method") !== "S256") return fail(400, "PKCE S256 is required");
          const scopes = (q.get("scope") ?? "").split(" ");
          if (!scopes.includes("fitness:health:enroll")) return fail(400, "missing scope");
          const state = q.get("state");
          const challenge = q.get("code_challenge");
          if (!state || !challenge) return fail(400, "state and code_challenge are required");
          const code = crypto.randomUUID();
          grants.set(code, { challenge, redirect: redirectUri, resource: q.get("resource") ?? "" });
          const location = `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}`;
          return new Response(null, { status: 302, headers: { location } });
        }
        if (request.method === "POST" && path === "/oauth/token") {
          const form = new URLSearchParams(await request.text());
          const grant = grants.get(form.get("code") ?? "");
          grants.delete(form.get("code") ?? "");
          if (!grant) return fail(400, "invalid_grant");
          const verifier = form.get("code_verifier") ?? "";
          const digest = createHash("sha256").update(verifier).digest("base64url");
          if (digest !== grant.challenge) return fail(400, "invalid_grant: PKCE");
          if (form.get("redirect_uri") !== grant.redirect) return fail(400, "invalid_grant: redirect URI");
          if (form.get("client_id") !== iosClient) return fail(400, "invalid_client");
          const token = `oat_sim_${++tokens}`;
          fake.oauth.set(token, {
            userId: syntheticOwner.id,
            clientId: iosClient,
            scopes: ["openid", "fitness:health:enroll"],
            aud: form.get("resource") || grant.resource,
          });
          return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
        }
        if (request.method === "POST" && path === "/api/health/devices") return devices.handleDeviceEnroll(request);
        if (request.method === "DELETE" && path === "/api/health/devices/current")
          return devices.handleDeviceRevoke(request);
        if (request.method === "POST" && path === "/api/health/import") return handleHealthImport(request);
        if (request.method === "GET" && path === "/__state") {
          const records = await loadRecords(syntheticOwner.id);
          return Response.json({
            weights: records.filter((r) => r.data.kind === "weight").map((r) => r.data),
            runs: records.filter((r) => r.data.kind === "run").map((r) => r.data),
            keys: fake.keys.map((k) => ({ revoked: k.revoked, kind: k.claims?.kind ?? null })),
          });
        }
        if (request.method === "POST" && path === "/__stop") {
          stop();
          return new Response(null, { status: 204 });
        }
        return fail(404, "not found");
      },
    });
    console.log(`Simulator harness on ${origin}`);
    await stopped;
    await server.stop();
    expect(true).toBe(true);
  },
  { timeout: 3_600_000 },
);
