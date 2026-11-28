/**
 * A local server for the iPhone app's Simulator flows. It serves the real
 * Fitness device and import handlers against Postgres, with Clerk replaced
 * by the synthetic fake, and a synthetic OAuth server in place of Clerk's
 * sign-in. The authorize endpoint signs in the synthetic owner at once and
 * redirects to the app with a code; the token endpoint checks the PKCE
 * verifier and redirect URI and issues an access token for the requested
 * resource, with a refresh token that issues new ones. The app API under
 * `/api/app` serves the account's records, photos and export.
 *
 * It runs only when FITNESS_IOS_SIM_PORT is set, until `POST /__stop`.
 * `GET /__state` lists the records the account holds and how many
 * imports and enrollments the harness received. `POST /__reset` starts
 * the next flow from an empty account and zero counts. `POST /__seed`
 * fills the account with three weeks of synthetic training, food and
 * weigh-ins for screenshots. Start it with
 * `apps/fitness-ios/scripts/flows.mjs`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Entity, RecordEntry } from "@bent/fitness-contracts/domain";
import {
  configure,
  installClerkFake,
  iosClient,
  syntheticOwner,
} from "./clerk-fake";
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
const app = await import("../src/server/app-api");
const { handleHealthImport } = await import("../src/server/health");
const { loadRecords, saveRecord } = await import("../src/server/store");
const { setMinimumAppContractForTests } =
  await import("../src/server/contract");
const { appContract } = await import("@bent/fitness-contracts");
// Serves the records contract this app build declares, so the seed holds
// everything the build reads.
setMinimumAppContractForTests(appContract);
const { addDays, createWorkout, defaultSettings, localDate, settingsId } =
  await import("@bent/fitness-contracts/domain");

const redirectUri = "build.bent.fitness.dev://oauth";

/** A fresh schema, Clerk fake and account settings for one flow. */
/**
 * Three weeks of synthetic history: settings that started then, finished
 * workouts on alternating routines, easy runs, daily weigh-ins and meals.
 */
async function seed() {
  const owner = syntheticOwner.id;
  const timezone = process.env.FITNESS_IOS_SIM_TIMEZONE ?? "UTC";
  const today = localDate(timezone);
  const start = addDays(today, -21);
  const defaults = defaultSettings(start, timezone);
  const settings = {
    ...defaults,
    goal: "Get stronger and run 5 km",
    // Today is a strength day with a timed exercise, so the screen tours
    // reach the workout logger, its hold timer and the Live Activity.
    dayPlans: {
      [today]: {
        type: "strength" as const,
        routine: defaults.routines[0] ?? null,
      },
    },
    // Carbs and fibre are tracked and fat isn't, so the tours show both.
    nutrients: { carbs: { target: 250 }, fibre: { target: 30 } },
  };
  const history: RecordEntry[] = [];
  const put = async (id: string, revision: number, data: Entity) => {
    const result = await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id,
      revision,
      data,
    });
    if (result.status === "saved" && result.record) history.push(result.record);
  };
  await put(settingsId, 1, settings);
  const regulars = [
    {
      name: "Greek yoghurt and berries",
      calories: 320,
      protein: 24,
      carbs: 34,
      fat: 8,
      fibre: 5,
    },
    {
      name: "Chicken rice bowl",
      calories: 640,
      protein: 48,
      carbs: 78,
      fat: 14,
      fibre: 6,
    },
  ];
  for (const meal of regulars)
    await put(crypto.randomUUID(), 0, { kind: "regular", ...meal });
  for (let offset = -21; offset <= 0; offset++) {
    const date = addDays(today, offset);
    const day = offset + 21;
    await put(crypto.randomUUID(), 0, {
      kind: "weight",
      date,
      kg: Math.round((82.4 - day * 0.06 + (day % 3) * 0.2) * 10) / 10,
    });
    for (const meal of [
      ...regulars,
      { name: "Toast with peanut butter", calories: 410, protein: 16 },
    ].slice(0, offset === 0 ? 2 : 3))
      await put(crypto.randomUUID(), 0, { kind: "meal", date, ...meal });
    if (offset === 0) continue;
    if (day % 7 === 2 || day % 7 === 5) {
      await put(crypto.randomUUID(), 0, {
        kind: "run",
        date,
        minutes: 28 + (day % 4),
        distanceKm: 4.2 + (day % 3) * 0.4,
        notes: "",
      });
    } else if (day % 7 === 0 || day % 7 === 3) {
      const routine =
        settings.routines[Math.floor(day / 3) % settings.routines.length];
      if (!routine) continue;
      const workout = createWorkout(settings, routine, date, day < 7, history);
      const startedAt = new Date(`${date}T07:00:00Z`).toISOString();
      await put(crypto.randomUUID(), 0, {
        ...workout,
        startedAt,
        finishedAt: new Date(`${date}T07:45:00Z`).toISOString(),
        exercises: workout.exercises.map((exercise) => ({
          ...exercise,
          sets: exercise.sets.map((set) => ({
            ...set,
            loadKg: set.loadKg || 8 + (day % 5) * 2,
            value: exercise.prescription.max,
            right: exercise.prescription.side
              ? exercise.prescription.max
              : null,
            done: true,
            rir: 2,
          })),
        })),
      });
    }
  }
}

async function prepare() {
  await isolated.create();
  await isolated
    .pool()
    .unsafe(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
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
}

beforeAll(async () => {
  if (configured) await prepare();
});
afterAll(async () => {
  if (configured) await isolated.drop();
});

type Grant = {
  challenge: string;
  redirect: string;
  resource: string;
  scopes: string[];
};

test.skipIf(!configured)(
  "serves the Simulator flows until stopped",
  async () => {
    const grants = new Map<string, Grant>();
    const refreshTokens = new Map<
      string,
      { resource: string; scopes: string[] }
    >();
    const requests: Record<string, number> = {};
    let tokens = 0;
    let stop = () => undefined as void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const fail = (status: number, error: string) =>
      Response.json({ error }, { status });

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request) {
        const started = performance.now();
        const path = new URL(request.url).pathname;
        if (!path.startsWith("/__"))
          requests[`${request.method} ${path}`] =
            (requests[`${request.method} ${path}`] ?? 0) + 1;
        const response = await route(request);
        const ms = Math.round(performance.now() - started);
        console.log(
          `harness ${request.method} ${new URL(request.url).pathname} ${response.status} ${ms}ms`,
        );
        return response;
      },
    });
    async function route(request: Request): Promise<Response> {
      {
        const url = new URL(request.url);
        const path = url.pathname;
        if (request.method === "GET" && path === "/oauth/authorize") {
          const q = url.searchParams;
          if (q.get("client_id") !== iosClient)
            return fail(400, "unknown client");
          if (q.get("redirect_uri") !== redirectUri)
            return fail(400, "unregistered redirect URI");
          if (q.get("response_type") !== "code")
            return fail(400, "response_type must be code");
          if (q.get("code_challenge_method") !== "S256")
            return fail(400, "PKCE S256 is required");
          const scopes = (q.get("scope") ?? "").split(" ");
          if (!scopes.includes("fitness:health:enroll"))
            return fail(400, "missing scope");
          const state = q.get("state");
          const challenge = q.get("code_challenge");
          if (!state || !challenge)
            return fail(400, "state and code_challenge are required");
          const code = crypto.randomUUID();
          grants.set(code, {
            challenge,
            redirect: redirectUri,
            resource: q.get("resource") ?? "",
            scopes,
          });
          const location = `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}`;
          return new Response(null, { status: 302, headers: { location } });
        }
        if (request.method === "POST" && path === "/oauth/token") {
          const form = new URLSearchParams(await request.text());
          if (form.get("client_id") !== iosClient)
            return fail(400, "invalid_client");
          const issue = (resource: string, scopes: string[]) => {
            const token = `oat_sim_${++tokens}`;
            fake.oauth.set(token, {
              userId: syntheticOwner.id,
              clientId: iosClient,
              scopes,
              aud: resource,
            });
            const refresh = scopes.includes("offline_access")
              ? `ort_sim_${crypto.randomUUID()}`
              : undefined;
            if (refresh) refreshTokens.set(refresh, { resource, scopes });
            return Response.json({
              access_token: token,
              token_type: "Bearer",
              expires_in: 3600,
              ...(refresh ? { refresh_token: refresh } : {}),
              scope: scopes.join(" "),
            });
          };
          if (form.get("grant_type") === "refresh_token") {
            const saved = refreshTokens.get(form.get("refresh_token") ?? "");
            if (!saved) return fail(400, "invalid_grant");
            refreshTokens.delete(form.get("refresh_token") ?? "");
            return issue(form.get("resource") || saved.resource, saved.scopes);
          }
          const grant = grants.get(form.get("code") ?? "");
          grants.delete(form.get("code") ?? "");
          if (!grant) return fail(400, "invalid_grant");
          const verifier = form.get("code_verifier") ?? "";
          const digest = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (digest !== grant.challenge)
            return fail(400, "invalid_grant: PKCE");
          if (form.get("redirect_uri") !== grant.redirect)
            return fail(400, "invalid_grant: redirect URI");
          return issue(form.get("resource") || grant.resource, grant.scopes);
        }
        if (request.method === "POST" && path === "/oauth/token/revoke") {
          const form = new URLSearchParams(await request.text());
          refreshTokens.delete(form.get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        if (path === "/api/app/records")
          return request.method === "POST"
            ? app.handleRecordSave(request)
            : app.handleRecordsLoad(request);
        if (path === "/api/app/photos")
          return request.method === "POST"
            ? app.handlePhotoUpload(request)
            : app.handlePhotoList(request);
        if (path.startsWith("/api/app/photos/")) {
          const id = path.slice("/api/app/photos/".length);
          return request.method === "DELETE"
            ? app.handlePhotoDelete(request, id)
            : app.handlePhotoRead(request, id);
        }
        if (request.method === "GET" && path === "/api/app/export")
          return app.handleExport(request);
        if (request.method === "POST" && path === "/api/health/devices")
          return devices.handleDeviceEnroll(request);
        if (
          request.method === "DELETE" &&
          path === "/api/health/devices/current"
        )
          return devices.handleDeviceRevoke(request);
        if (request.method === "POST" && path === "/api/health/import")
          return handleHealthImport(request);
        if (request.method === "GET" && path === "/__state") {
          const records = await loadRecords(syntheticOwner.id);
          return Response.json({
            weights: records
              .filter((r) => r.data.kind === "weight")
              .map((r) => r.data),
            runs: records
              .filter((r) => r.data.kind === "run")
              .map((r) => r.data),
            keys: fake.keys.map((k) => ({
              revoked: k.revoked,
              kind: k.claims?.kind ?? null,
            })),
            imports: requests["POST /api/health/import"] ?? 0,
            enrollments: requests["POST /api/health/devices"] ?? 0,
          });
        }
        if (request.method === "POST" && path === "/__reset") {
          await isolated.drop();
          await prepare();
          grants.clear();
          refreshTokens.clear();
          for (const key of Object.keys(requests)) delete requests[key];
          return new Response(null, { status: 204 });
        }
        // The exercise illustrations, as fitness.bent.build serves them.
        if (
          request.method === "GET" &&
          /^\/exercise-guides\/(thumbs\/)?[a-z]+\.(png|jpg)$/.test(path)
        ) {
          const file = Bun.file(new URL(`../public${path}`, import.meta.url));
          return (await file.exists())
            ? new Response(file)
            : fail(404, "not found");
        }
        if (request.method === "POST" && path === "/__seed") {
          await seed();
          return new Response(null, { status: 204 });
        }
        if (request.method === "POST" && path === "/__stop") {
          stop();
          return new Response(null, { status: 204 });
        }
        return fail(404, "not found");
      }
    }
    console.log(`Simulator harness on ${origin}`);
    await stopped;
    await server.stop();
    expect(true).toBe(true);
  },
  { timeout: 3_600_000 },
);
