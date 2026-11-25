import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  bearer,
  configure,
  installClerkFake,
  iosClient,
  resource,
  syntheticOwner,
} from "./clerk-fake";
import { isolatedSchema } from "./isolated-schema";

const fake = installClerkFake();
const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
// This suite runs in a schema of its own, dropped when it ends.
const isolated = isolatedSchema("fitness_devices");
if (configured) configure(process.env.FITNESS_TEST_DATABASE_URL ?? "");
const environment = { ...process.env };
const { default: postgres } = await import("postgres");
const { commitCutProxy } = await import("./commit-cut-proxy");
const { setDatabaseForTests } = await import("../src/server/db");
const { database } = await import("../src/server/db");
const devices = await import("../src/server/devices");
const { handleHealthImport } = await import("../src/server/health");
const reply = await import("../src/server/device-reply");
const store = await import("../src/server/store");
const { loadRecords, saveRecord } = store;
// The enrollment table as an earlier schema version created it.
const EARLIER_ENROLLMENTS = await Bun.file(
  new URL("./fixtures/schema/enrollments-earlier.sql", import.meta.url),
).text();
const { defaultSettings, settingsId } = await import("../src/domain");

const owner = syntheticOwner.id;
const timezone = "Australia/Brisbane";
// The device clock: midday on 20 November 2026 in Brisbane.
const now = new Date("2026-11-20T02:00:00Z");
const installation = "6f1c2a7e-3d4b-4c5a-8e9f-0a1b2c3d4e5f";
const otherInstallation = (n: number) =>
  `6f1c2a7e-3d4b-4c5a-8e9f-0a1b2c3d4e${String(n).padStart(2, "0")}`;

async function clean() {
  const sql = database();
  await sql`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
  await sql`DELETE FROM fitness_health_samples WHERE owner_id=${owner}`;
  await sql`DELETE FROM fitness_operations WHERE owner_id=${owner}`;
  await sql`DELETE FROM fitness_records WHERE owner_id=${owner}`;
  await sql`DELETE FROM fitness_accounts WHERE owner_id=${owner}`;
}
beforeAll(async () => {
  if (!configured) return;
  await isolated.create();
  await database().unsafe(
    await Bun.file(new URL("../schema.sql", import.meta.url)).text(),
  );
  await clean();
  await saveRecord(owner, {
    operationId: crypto.randomUUID(),
    id: settingsId,
    revision: 0,
    data: defaultSettings("2026-11-01", timezone),
  });
});
afterAll(async () => {
  if (configured) await isolated.drop();
});
beforeEach(async () => {
  fake.reset();
  Object.assign(process.env, environment);
  devices.setEnrollmentBudget(1000, 1000);
  devices.setSharedEnrollmentLimit(100_000);
  store.forgetFullAttemptWindow();
  devices.setEnrollmentTiming();
  store.setEnrollmentWait();
  if (configured) {
    await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
  }
});

function oauthToken(
  overrides: Partial<{
    userId: string;
    clientId: string;
    scopes: string[];
    aud: string | string[] | undefined;
    expired: boolean;
    id: string;
  }> = {},
) {
  const token = "oat_" + crypto.randomUUID();
  fake.oauth.set(token, {
    userId: owner,
    clientId: iosClient,
    scopes: ["openid", "fitness:health:enroll"],
    aud: resource,
    ...overrides,
  });
  return token;
}
/** The app's count of enrollment attempts, one higher for each. */
let sequence = 0;
/**
 * Sends an enrollment. A body without an `enrollmentSequence` gets the next
 * one, as the app counts its attempts.
 */
function enroll(
  token: string | null,
  body: unknown = {
    installationId: installation,
    deviceName: "Synthetic iPhone",
  },
  headers: Record<string, string> = {},
) {
  const counted =
    typeof body === "object" && body !== null && !("enrollmentSequence" in body)
      ? { ...body, enrollmentSequence: ++sequence }
      : body;
  const init = {
    method: "POST",
    body: JSON.stringify(counted),
    headers: { "content-type": "application/json", ...headers },
  };
  return devices.handleDeviceEnroll(
    token === null
      ? new Request("http://127.0.0.1:3025/api/health/devices", init)
      : bearer(token, init, "/api/health/devices"),
  );
}
/** Enrolls an installation with a fresh token and returns its key. */
async function enrolled(id = installation) {
  const response = await enroll(oauthToken(), {
    installationId: id,
    deviceName: "Synthetic iPhone",
  });
  if (response.status !== 201)
    throw new Error(`Enrollment failed with ${response.status}.`);
  return (await response.json()).secret as string;
}
/** Imports one weigh-in with a key. */
function importWith(secret: string) {
  const body = {
    data: {
      metrics: [
        {
          name: "weight_body_mass",
          units: "kg",
          data: [
            {
              ref: `w:${crypto.randomUUID()}`,
              date: "2026-09-15T06:00:00+10:00",
              qty: 80,
            },
          ],
        },
      ],
    },
  };
  return handleHealthImport(
    bearer(
      secret,
      { method: "POST", body: JSON.stringify(body) },
      "/api/health/import",
    ),
    { now },
  );
}
/** Waits until `count` backends in this database are waiting on a lock. */
async function lockWaiters(count = 1) {
  for (let n = 0; n < 500; n++) {
    const [row] =
      await database()`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.waiting ?? 0) >= count) return;
    await Bun.sleep(10);
  }
  throw new Error(`Expected ${count} backend(s) waiting on a lock.`);
}
/**
 * Waits for a backend that `pid` blocks, connected as `application` and
 * running `statement`, and returns its PID.
 */
async function blockedBy(pid: number, application: string, statement: string) {
  for (let n = 0; n < 300; n++) {
    const [row] =
      await database()`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = ${application} AND ${pid} = ANY(pg_blocking_pids(pid)) AND query ILIKE ${"%" + statement + "%"}`;
    if (row) return Number(row.pid);
    await Bun.sleep(10);
  }
  throw new Error(`Expected a backend running ${statement} behind ${pid}.`);
}
/** Holds the owner's account row from another connection until released. */
function holdAccount(sql: ReturnType<typeof postgres>) {
  let release = () => undefined as void;
  let locked = () => undefined as void;
  const taken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = sql.begin(async (tx) => {
    await tx`SELECT 1 FROM fitness_accounts WHERE owner_id=${owner} FOR UPDATE`;
    locked();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  return { taken, done, release: () => release() };
}
/** The owner's enrollment attempts, oldest first. */
async function rows() {
  const found =
    await database()`SELECT key_state, active FROM fitness_device_enrollments WHERE owner_id=${owner} ORDER BY created_at`;
  return found.map((r) => ({ key_state: r.key_state, active: r.active }));
}
const activeFor = (id: string) =>
  fake.keys.filter((k) => !k.revoked && k.claims?.installationId === id);

describe("device enrollment", () => {
  test.skipIf(!configured)(
    "issues an import-only key for the verified account",
    async () => {
      const response = await enroll(oauthToken());
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        secret: expect.stringMatching(/^ak_/),
        accountTimezone: timezone,
        userId: owner,
        email: syntheticOwner.email,
      });
      const [key] = activeFor(installation);
      expect(key).toMatchObject({
        secret: body.secret,
        subject: owner,
        name: "iPhone sync: Synthetic iPhone",
        scopes: ["fitness:health:import"],
        claims: { kind: "fitness-ios", installationId: installation },
      });
    },
  );

  test.skipIf(!configured)("refuses tokens that cannot enroll", async () => {
    fake.addKey({ secret: "ak_owner" });
    fake.users.set("user_uninvited", {
      email: "uninvited@example.com",
      verified: true,
    });
    const cases: [string, Promise<Response>, number, string][] = [
      [
        "a cookie-only request",
        enroll(null, undefined, { cookie: "__session=browser" }),
        401,
        "unauthorized",
      ],
      [
        "a session-token bearer",
        enroll("eyJhbGciOiJSUzI1NiJ9.e30.x"),
        401,
        "unauthorized",
      ],
      ["an API-key bearer", enroll("ak_owner"), 401, "unauthorized"],
      ["an unknown token", enroll("oat_unknown"), 401, "unauthorized"],
      [
        "an expired token",
        enroll(oauthToken({ expired: true })),
        401,
        "unauthorized",
      ],
      [
        "the wrong audience",
        enroll(oauthToken({ aud: "https://other.example.com/api/mcp" })),
        401,
        "unauthorized",
      ],
      [
        "no audience",
        enroll(oauthToken({ aud: undefined })),
        401,
        "unauthorized",
      ],
      [
        "an MCP token without the enroll scope",
        enroll(
          oauthToken({ scopes: ["openid", "fitness:read", "fitness:write"] }),
        ),
        403,
        "insufficient_scope",
      ],
      [
        "the scope from another client",
        enroll(oauthToken({ clientId: "client_dynamic" })),
        403,
        "client_not_allowed",
      ],
      [
        "an uninvited account",
        enroll(oauthToken({ userId: "user_uninvited" })),
        403,
        "not_invited",
      ],
      [
        "an invalid body",
        enroll(oauthToken(), { installationId: "phone", deviceName: "" }),
        400,
        "invalid_request",
      ],
    ];
    for (const [name, pending, status, code] of cases) {
      const response = await pending;
      expect({ name, status: response.status }).toEqual({ name, status });
      expect({ name, body: await response.json() }).toMatchObject({
        name,
        body: { code },
      });
    }
    expect(fake.keys.filter((k) => k.claims?.kind === "fitness-ios")).toEqual(
      [],
    );
  });

  test.skipIf(!configured)(
    "accepts the bearer and ignores the session cookie",
    async () => {
      const response = await enroll(oauthToken(), undefined, {
        cookie: "__session=browser",
      });
      expect(response.status).toBe(201);
      for (const { request } of fake.requests)
        expect(request.headers.get("cookie")).toBeNull();
    },
  );

  test.skipIf(!configured)("uses each token once", async () => {
    const token = oauthToken();
    expect((await enroll(token)).status).toBe(201);
    for (const id of [installation, otherInstallation(1)]) {
      const again = await enroll(token, {
        installationId: id,
        deviceName: "Another iPhone",
      });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({
        code: "enrollment_token_used",
      });
    }
    expect(activeFor(installation)).toHaveLength(1);
    expect(activeFor(otherInstallation(1))).toHaveLength(0);
    // Two requests with one token at once: recording takes turns on the
    // account row, so only one uses it.
    const shared = oauthToken();
    const together = await Promise.all(
      [2, 3].map((n) =>
        enroll(shared, {
          installationId: otherInstallation(n),
          deviceName: "Another iPhone",
        }),
      ),
    );
    expect(together.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      activeFor(otherInstallation(2)).length +
        activeFor(otherInstallation(3)).length,
    ).toBe(1);
  });

  test.skipIf(!configured)(
    "uses up a token by the ID Clerk verified, however it is written",
    async () => {
      // Two strings Clerk verifies as the same token.
      const first = oauthToken({ id: "oat_synthetic_same" });
      const second = oauthToken({ id: "oat_synthetic_same" });
      expect((await enroll(first)).status).toBe(201);
      const again = await enroll(second, {
        installationId: otherInstallation(1),
        deviceName: "Another iPhone",
      });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({
        code: "enrollment_token_used",
      });
      expect(activeFor(otherInstallation(1))).toHaveLength(0);
      // A token Clerk verifies without an ID cannot be used up, so it is refused.
      const unnamed = await enroll(oauthToken({ id: "" }));
      expect(unnamed.status).toBe(401);
      expect(await unnamed.json()).toMatchObject({ code: "unauthorized" });
    },
  );

  test.skipIf(!configured)(
    "replaces the installation's key after a lost reply",
    async () => {
      const lost = await enrolled();
      // The reply never reached the app, so it signs in again.
      const kept = await enrolled();
      expect(kept).not.toBe(lost);
      expect(activeFor(installation).map((k) => k.secret)).toEqual([kept]);
      expect(fake.keys.find((k) => k.secret === lost)?.revoked).toBe(true);
      expect((await importWith(lost)).status).toBe(401);
      expect((await importWith(kept)).status).toBe(200);
      expect(await rows()).toEqual([
        { key_state: "issued", active: false },
        { key_state: "issued", active: true },
      ]);
    },
  );

  test.skipIf(!configured)(
    "keeps one active key when two enrollments for an installation overlap",
    async () => {
      const previous = await enrolled();
      // Both creates wait until both have started.
      let release = () => undefined as void;
      fake.stall = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      let both = () => undefined as void;
      const creating = new Promise<void>((resolve) => {
        both = resolve;
      });
      fake.onCreate = () => {
        if (++started === 2) both();
      };
      const first = enroll(oauthToken());
      const second = enroll(oauthToken());
      let replies: Response[];
      try {
        await creating;
        // Ordinary Fitness queries still get a connection, and the current
        // key keeps importing until a replacement is swapped in.
        expect((await loadRecords(owner)).length).toBeGreaterThan(0);
        expect((await importWith(previous)).status).toBe(200);
        release();
        replies = await Promise.all([first, second]);
      } finally {
        release();
        fake.stall = null;
        fake.onCreate = null;
      }
      // The swaps take turns on the account row, and the attempt with the
      // higher sequence wins whichever runs first: the other is refused,
      // as it would be replaced.
      const [newest] =
        await database()`SELECT attempt_id FROM fitness_device_enrollments WHERE owner_id=${owner} ORDER BY enrollment_sequence DESC LIMIT 1`;
      const winner = fake.keys.find(
        (k) => k.claims?.enrollment === String(newest?.attempt_id),
      );
      if (!winner) throw new Error("Expected the newer attempt's key.");
      const bodies = await Promise.all(replies.map((r) => r.json()));
      const answers = replies.map((r, n) => ({
        status: r.status,
        secret: bodies[n]?.secret as string | undefined,
      }));
      expect(answers).toContainEqual({ status: 201, secret: winner.secret });
      expect(answers.map((a) => a.status).sort()).toEqual([201, 503]);
      expect((await rows()).filter((r) => r.active)).toHaveLength(1);
      expect(activeFor(installation).map((k) => k.secret)).toEqual([
        winner.secret,
      ]);
      expect((await importWith(winner.secret)).status).toBe(200);
      for (const answer of answers)
        if (answer.secret && answer.secret !== winner.secret)
          expect((await importWith(answer.secret)).status).toBe(401);
      expect((await importWith(previous)).status).toBe(401);
    },
  );

  test.skipIf(!configured)(
    "leaves a key another enrollment is still swapping in, and revokes an abandoned one",
    async () => {
      // The first enrollment has its key from Clerk and waits to swap it in.
      const original = store.swapEnrollment;
      let releaseSwap = () => undefined as void;
      const gate = new Promise<void>((resolve) => {
        releaseSwap = resolve;
      });
      let reached = () => undefined as void;
      const atSwap = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const spy = spyOn(store, "swapEnrollment").mockImplementation(
        async (...args) => {
          if (args[1].installationId === installation) {
            reached();
            await gate;
          }
          return original(...args);
        },
      );
      let first: Promise<Response> | undefined;
      try {
        first = enroll(oauthToken());
        await atSwap;
        // Another enrollment cleans up meanwhile, and keeps the first key.
        const second = await enroll(oauthToken(), {
          installationId: otherInstallation(1),
          deviceName: "Second iPhone",
        });
        expect(second.status).toBe(201);
        releaseSwap();
        const response = await first;
        expect(response.status).toBe(201);
        const secret = (await response.json()).secret;
        expect(fake.keys.find((k) => k.secret === secret)?.revoked).toBe(false);
        expect((await importWith(secret)).status).toBe(200);
      } finally {
        releaseSwap();
        await first;
        spy.mockRestore();
      }
      // An attempt still pending after the grace was abandoned, so the
      // next enrollment revokes its key.
      const abandoned = crypto.randomUUID();
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,created_at) VALUES(${owner},${"f".repeat(64)},${abandoned},${otherInstallation(2)},now() - interval '11 minutes')`;
      const left = fake.addKey({
        secret: "ak_abandoned",
        scopes: ["fitness:health:import"],
        claims: {
          kind: "fitness-ios",
          installationId: otherInstallation(2),
          enrollment: abandoned,
        },
      });
      expect((await enroll(oauthToken())).status).toBe(201);
      expect(left.revoked).toBe(true);
    },
  );

  test.skipIf(!configured)(
    "lets only one of two new installations overlapping at the limit through",
    async () => {
      for (const n of [1, 2]) await enrolled(otherInstallation(n));
      // The first enrollment for a new installation waits in Clerk's create
      // while the second records its attempt.
      let release = () => undefined as void;
      fake.stall = new Promise<void>((resolve) => {
        release = resolve;
      });
      const creating = new Promise<void>((resolve) => {
        fake.onCreate = resolve;
      });
      const firstToken = oauthToken();
      const secondToken = oauthToken();
      let first: Promise<Response> | undefined;
      let second: Response;
      try {
        first = enroll(firstToken, {
          installationId: otherInstallation(3),
          deviceName: "Third iPhone",
        });
        await creating;
        second = await enroll(secondToken, {
          installationId: otherInstallation(4),
          deviceName: "Fourth iPhone",
        });
      } finally {
        release();
        fake.stall = null;
        fake.onCreate = null;
      }
      expect((await first).status).toBe(201);
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ code: "device_limit" });
      expect(
        (
          await database()`SELECT count(DISTINCT installation_id)::int AS n FROM fitness_device_enrollments WHERE owner_id=${owner} AND active`
        )[0]?.n,
      ).toBe(3);
      // The refusal left its token unused: once a place frees, it enrolls.
      const [freed] = activeFor(otherInstallation(1));
      if (!freed) throw new Error("Expected the key.");
      freed.revoked = true;
      expect(
        (
          await enroll(secondToken, {
            installationId: otherInstallation(4),
            deviceName: "Fourth iPhone",
          })
        ).status,
      ).toBe(201);
    },
  );

  test.skipIf(!configured)(
    "fails a request that resumes after its abandoned attempt was cleaned up",
    async () => {
      const previous = await enrolled();
      // This enrollment has its key from Clerk, then pauses before the swap.
      const original = store.swapEnrollment;
      let resume = () => undefined as void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let reached = () => undefined as void;
      const atSwap = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const spy = spyOn(store, "swapEnrollment").mockImplementation(
        async (...args) => {
          if (args[1].installationId === installation) {
            reached();
            await gate;
          }
          return original(...args);
        },
      );
      let stalled: Promise<Response> | undefined;
      try {
        stalled = enroll(oauthToken());
        await atSwap;
        // Its attempt passes the grace, and another enrollment cleans up.
        await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '11 minutes' WHERE owner_id=${owner} AND key_state='pending'`;
        expect(
          (
            await enroll(oauthToken(), {
              installationId: otherInstallation(1),
              deviceName: "Second iPhone",
            })
          ).status,
        ).toBe(201);
        resume();
        const response = await stalled;
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          code: "issuance_failed",
        });
      } finally {
        resume();
        await stalled;
        spy.mockRestore();
      }
      // The abandoned key was revoked, and the installation's key works.
      expect((await importWith(previous)).status).toBe(200);
      expect(activeFor(installation).map((k) => k.secret)).toEqual([previous]);
      const [abandoned] =
        await database()`SELECT key_state, active, charged_at IS NOT NULL AS charged FROM fitness_device_enrollments WHERE owner_id=${owner} AND installation_id=${installation} AND NOT active`;
      expect({ ...abandoned }).toEqual({
        key_state: "ambiguous",
        active: false,
        charged: true,
      });
    },
  );

  test.skipIf(!configured)(
    "asks for a new sign-in when recording's commit reply is lost",
    async () => {
      const proxy = await commitCutProxy(new URL(isolated.url));
      const pool = postgres(proxy.url, {
        max: 3,
        prepare: false,
        onnotice: () => undefined,
      });
      const original = store.recordEnrollment;
      const arming = spyOn(store, "recordEnrollment").mockImplementation(
        async (...args) => {
          proxy.arm();
          return original(...args);
        },
      );
      let creates = 0;
      fake.onCreate = () => {
        creates += 1;
      };
      const token = oauthToken();
      setDatabaseForTests(pool);
      let response: Response;
      let committed: { key_state: string; active: boolean }[] = [];
      try {
        response = await enroll(token);
        // The commit is seen through a pool of its own before the proxy
        // closes, so closing it cannot race the commit.
        for (let n = 0; n < 300 && committed.length === 0; n++) {
          committed = (
            await isolated.pool()`SELECT key_state, active FROM fitness_device_enrollments WHERE owner_id=${owner}`
          ).map((r) => ({
            key_state: String(r.key_state),
            active: r.active === true,
          }));
          if (committed.length === 0) await Bun.sleep(10);
        }
      } finally {
        arming.mockRestore();
        fake.onCreate = null;
        setDatabaseForTests(isolated.pool());
        await pool.end({ timeout: 1 }).catch(() => undefined);
        await proxy.close();
      }
      expect(committed).toEqual([{ key_state: "pending", active: false }]);
      expect(proxy.cuts).toBe(1);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "issuance_failed" });
      // Clerk was never asked for a key, yet Postgres has the commit, so the
      // token is used.
      expect(creates).toBe(0);
      const again = await enroll(token);
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({
        code: "enrollment_token_used",
      });
    },
  );

  test.skipIf(!configured)(
    "creates no key for an attempt whose place in the hourly limit has lapsed",
    async () => {
      // The first enrollment pauses after cleanup, before its create.
      const original = store.unneededKeys;
      let resume = () => undefined as void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let reached = () => undefined as void;
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let calls = 0;
      const spy = spyOn(store, "unneededKeys").mockImplementation(
        async (...args) => {
          const keys = await original(...args);
          if (++calls === 1) {
            reached();
            await gate;
          }
          return keys;
        },
      );
      let stalled: Promise<Response> | undefined;
      try {
        stalled = enroll(oauthToken());
        await paused;
        const [{ attempt_id: lapsed } = { attempt_id: "" }] =
          await database()`SELECT attempt_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND key_state='pending'`;
        // Its reservation passes the hourly window, and five other
        // enrollments fill the hour meanwhile.
        await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '25 hours' WHERE attempt_id=${lapsed}`;
        for (let n = 0; n < 5; n++) await enrolled();
        resume();
        const response = await stalled;
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          code: "issuance_failed",
        });
        // No sixth key was created, and the hour stays full.
        expect(
          fake.keys.filter((k) => k.claims?.enrollment === String(lapsed)),
        ).toEqual([]);
        expect(
          fake.keys.filter((k) => k.claims?.kind === "fitness-ios"),
        ).toHaveLength(5);
        expect((await enroll(oauthToken())).status).toBe(429);
      } finally {
        resume();
        await stalled;
        spy.mockRestore();
      }
    },
  );

  test.skipIf(!configured)(
    "keeps a failed create's place in the hourly limit unless Clerk's own error rejected it",
    async () => {
      for (const [mode, state, next] of [
        ["rejected", "failed", 201],
        ["gateway", "ambiguous", 429],
      ] as const) {
        await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
        fake.keys = [];
        for (let n = 0; n < 4; n++) await enrolled();
        fake.create = mode;
        const failed = await enroll(oauthToken());
        fake.create = "ok";
        expect(failed.status).toBe(503);
        expect(await failed.json()).toMatchObject({ code: "issuance_failed" });
        const [newest] =
          await database()`SELECT key_state FROM fitness_device_enrollments WHERE owner_id=${owner} ORDER BY created_at DESC LIMIT 1`;
        expect({ mode, state: newest?.key_state }).toEqual({ mode, state });
        // A rejection frees the attempt's place; any other failure keeps it.
        expect({ mode, next: (await enroll(oauthToken())).status }).toEqual({
          mode,
          next,
        });
      }
    },
  );

  test.skipIf(!configured)(
    "charges a failed attempt whose key turns up in Clerk's list",
    async () => {
      await database()`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      const failed = crypto.randomUUID();
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,key_state) VALUES(${owner},${"b".repeat(64)},${failed},${otherInstallation(1)},'failed')`;
      const key = fake.addKey({
        secret: "ak_failed_attempt",
        scopes: ["fitness:health:import"],
        claims: {
          kind: "fitness-ios",
          installationId: otherInstallation(1),
          enrollment: failed,
        },
      });
      expect((await enroll(oauthToken())).status).toBe(201);
      const [row] =
        await database()`SELECT key_state, charged_at IS NOT NULL AS charged FROM fitness_device_enrollments WHERE attempt_id=${failed}`;
      expect({ ...row }).toEqual({ key_state: "failed", charged: true });
      expect(key.revoked).toBe(true);
    },
  );

  test.skipIf(!configured)(
    "never swaps in an attempt that aged past the grace, even without a cleanup",
    async () => {
      const previous = await enrolled();
      // The key is created; the attempt then ages past the grace before
      // its swap, and no other enrollment cleans up meanwhile.
      const original = store.swapEnrollment;
      const aged = spyOn(store, "swapEnrollment").mockImplementation(
        async (...args) => {
          await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '11 minutes' WHERE attempt_id=${args[1].attemptId}`;
          return original(...args);
        },
      );
      let response: Response;
      try {
        response = await enroll(oauthToken());
      } finally {
        aged.mockRestore();
      }
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "issuance_failed" });
      expect((await importWith(previous)).status).toBe(200);
      const newest = fake.keys.reduce((a, b) =>
        a.createdAt >= b.createdAt ? a : b,
      );
      expect(newest.secret).not.toBe(previous);
      expect(newest.revoked).toBe(true);
      expect((await importWith(newest.secret)).status).toBe(401);
      const [row] =
        await database()`SELECT key_state, active, charged_at IS NOT NULL AS charged FROM fitness_device_enrollments WHERE owner_id=${owner} ORDER BY created_at LIMIT 1`;
      expect({ ...row }).toEqual({
        key_state: "ambiguous",
        active: false,
        charged: true,
      });
    },
  );

  test.skipIf(!configured)(
    "fails a request whose key a later enrollment replaced before its reply",
    async () => {
      for (const read of ["works", "fails"] as const) {
        await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
        fake.keys = [];
        const previous = await enrolled();
        const previousKey = fake.keys.find((k) => k.secret === previous);
        if (!previousKey) throw new Error("Expected the key.");
        // A swaps in its key, then waits while Clerk revokes the key it
        // replaced. B's cleanup gives up on that key quickly.
        devices.setEnrollmentTiming({ cleanupMs: 300 });
        let releaseA = () => undefined as void;
        let reachedA = () => undefined as void;
        const atRevoke = new Promise<void>((resolve) => {
          reachedA = resolve;
        });
        fake.revokeHold = {
          id: previousKey.id,
          gate: new Promise<void>((resolve) => {
            releaseA = resolve;
          }),
          reached: () => reachedA(),
        };
        let a: Promise<Response> | undefined;
        const recheck = spyOn(store, "deviceKeyActive");
        try {
          a = enroll(oauthToken());
          await atRevoke;
          // B replaces A's key for the same installation and finishes.
          const b = await enroll(oauthToken());
          expect(b.status).toBe(201);
          const bSecret = (await b.json()).secret;
          // A's final read fails this round, so A returns its stale key.
          if (read === "fails")
            recheck.mockImplementationOnce(() =>
              Promise.reject(new Error("Connection closed")),
            );
          releaseA();
          const response = await a;
          if (read === "works") {
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({
              code: "issuance_failed",
            });
          } else {
            expect(response.status).toBe(201);
            const stale = (await response.json()).secret;
            expect(stale).not.toBe(bSecret);
            expect((await importWith(stale)).status).toBe(401);
          }
          // Either way, B's key is the one that keeps working.
          expect((await importWith(bSecret)).status).toBe(200);
          expect(activeFor(installation).map((k) => k.secret)).toEqual([
            bSecret,
          ]);
          expect((await rows()).filter((r) => r.active)).toHaveLength(1);
        } finally {
          releaseA();
          await a;
          recheck.mockRestore();
          fake.revokeHold = null;
          devices.setEnrollmentTiming();
        }
      }
    },
  );

  test.skipIf(!configured)(
    "never lets an older enrollment replace the key of a newer one",
    async () => {
      const previous = await enrolled();
      // A records its attempt and gets its key, then waits before its swap.
      const original = store.swapEnrollment;
      let releaseA = () => undefined as void;
      const gate = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let reached = () => undefined as void;
      const atSwap = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let calls = 0;
      const spy = spyOn(store, "swapEnrollment").mockImplementation(
        async (...args) => {
          if (++calls === 1) {
            reached();
            await gate;
          }
          return original(...args);
        },
      );
      let a: Promise<Response> | undefined;
      try {
        a = enroll(oauthToken());
        await atSwap;
        // The newer B finishes, and the phone saves and uses its key.
        const b = await enroll(oauthToken());
        expect(b.status).toBe(201);
        const bSecret = (await b.json()).secret;
        expect((await importWith(bSecret)).status).toBe(200);
        releaseA();
        const response = await a;
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          code: "issuance_failed",
        });
        expect((await importWith(bSecret)).status).toBe(200);
        const [, older] =
          await database()`SELECT attempt_id, key_state, charged_at IS NOT NULL AS charged FROM fitness_device_enrollments WHERE owner_id=${owner} ORDER BY enrollment_sequence`;
        expect({ state: older?.key_state, charged: older?.charged }).toEqual({
          state: "failed",
          charged: true,
        });
        const aKey = fake.keys.find(
          (k) => k.claims?.enrollment === String(older?.attempt_id),
        );
        expect(aKey?.revoked).toBe(true);
        expect((await rows()).filter((r) => r.active)).toHaveLength(1);
        expect((await importWith(previous)).status).toBe(401);
      } finally {
        releaseA();
        await a;
        spy.mockRestore();
      }
    },
  );

  test.skipIf(!configured)(
    "keeps the key of the app's later attempt whichever attempt is recorded or swapped first",
    async () => {
      for (const order of [
        "later swaps first",
        "earlier swaps first",
      ] as const) {
        await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
        fake.keys = [];
        const previous = await enrolled();
        // The app starts A, then B, so B has the higher sequence. A pauses
        // before it is recorded, so B is recorded first.
        const aSequence = ++sequence;
        const bSequence = ++sequence;
        const originalRecord = store.recordEnrollment;
        let releaseA = () => undefined as void;
        const aGate = new Promise<void>((resolve) => {
          releaseA = resolve;
        });
        let aReached = () => undefined as void;
        const aAtRecord = new Promise<void>((resolve) => {
          aReached = resolve;
        });
        const recording = spyOn(store, "recordEnrollment").mockImplementation(
          async (...args) => {
            if (args[1].enrollmentSequence === aSequence) {
              aReached();
              await aGate;
            }
            return originalRecord(...args);
          },
        );
        // For the second order, B waits before its swap until A is done.
        const originalSwap = store.swapEnrollment;
        let releaseB = () => undefined as void;
        const bGate = new Promise<void>((resolve) => {
          releaseB = resolve;
        });
        let bReached = () => undefined as void;
        const bAtSwap = new Promise<void>((resolve) => {
          bReached = resolve;
        });
        const swapping = spyOn(store, "swapEnrollment").mockImplementation(
          async (...args) => {
            const [row] =
              await database()`SELECT enrollment_sequence FROM fitness_device_enrollments WHERE attempt_id=${args[1].attemptId}`;
            if (
              order === "earlier swaps first" &&
              Number(row?.enrollment_sequence) === bSequence
            ) {
              bReached();
              await bGate;
            }
            return originalSwap(...args);
          },
        );
        const body = (enrollmentSequence: number) => ({
          installationId: installation,
          deviceName: "Synthetic iPhone",
          enrollmentSequence,
        });
        let a: Promise<Response> | undefined;
        let b: Promise<Response> | undefined;
        try {
          a = enroll(oauthToken(), body(aSequence));
          await aAtRecord;
          b = enroll(oauthToken(), body(bSequence));
          let aResponse: Response;
          let bResponse: Response;
          if (order === "later swaps first") {
            bResponse = await b;
            releaseA();
            aResponse = await a;
            // A is recorded after B's key is current, so it is refused
            // before anything changes, and its token stays unused.
            expect(aResponse.status).toBe(409);
            expect(await aResponse.json()).toMatchObject({
              code: "stale_enrollment",
            });
          } else {
            await bAtSwap;
            releaseA();
            aResponse = await a;
            releaseB();
            bResponse = await b;
            // A's swap finds B still being issued, so it never replaces
            // the current key, and its own key is revoked.
            expect(aResponse.status).toBe(503);
            expect(await aResponse.json()).toMatchObject({
              code: "issuance_failed",
            });
            const [aRow] =
              await database()`SELECT attempt_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND enrollment_sequence=${aSequence}`;
            const aKey = fake.keys.find(
              (k) => k.claims?.enrollment === String(aRow?.attempt_id),
            );
            expect(aKey?.revoked).toBe(true);
          }
          expect(bResponse.status).toBe(201);
          const bSecret = (await bResponse.json()).secret;
          expect((await importWith(bSecret)).status).toBe(200);
          expect(activeFor(installation).map((k) => k.secret)).toEqual([
            bSecret,
          ]);
          expect((await rows()).filter((r) => r.active)).toHaveLength(1);
          expect((await importWith(previous)).status).toBe(401);
        } finally {
          releaseA();
          releaseB();
          await Promise.allSettled([a, b]);
          recording.mockRestore();
          swapping.mockRestore();
        }
      }
    },
  );

  test.skipIf(!configured)(
    "refuses a stale attempt and leaves its token unused",
    async () => {
      const current = await enrolled();
      const [active] =
        await database()`SELECT enrollment_sequence FROM fitness_device_enrollments WHERE owner_id=${owner} AND active`;
      const token = oauthToken();
      const stale = await enroll(token, {
        installationId: installation,
        deviceName: "Synthetic iPhone",
        enrollmentSequence: Number(active?.enrollment_sequence),
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "stale_enrollment" });
      expect((await importWith(current)).status).toBe(200);
      // The app re-links with a later count, and the same token works.
      expect((await enroll(token)).status).toBe(201);
      expect((await importWith(current)).status).toBe(401);
    },
  );

  test.skipIf(!configured)(
    "the commit-cut proxy refuses a client's SSL request and reaches the database as the driver does",
    async () => {
      const proxy = await commitCutProxy(new URL(isolated.url));
      const client = postgres(proxy.url, {
        max: 1,
        prepare: false,
        ssl: "prefer",
        onnotice: () => undefined,
      });
      const direct = postgres(isolated.url, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      try {
        const [proxied] =
          await client`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
        expect(proxy.refusedEncryption).toBe(1);
        const [straight] =
          await direct`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
        expect(proxied?.ssl).toBe(straight?.ssl);
      } finally {
        await client.end();
        await direct.end();
        await proxy.close();
      }
    },
  );

  test.skipIf(!configured)(
    "the commit-cut proxy reaches a database without TLS in plaintext under allow and prefer, as the driver does",
    async () => {
      const direct = postgres(isolated.url, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      try {
        const [row] =
          await direct`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
        // Only a database that declines TLS shows the fallback.
        if (row?.ssl !== false) return;
        for (const mode of ["allow", "prefer", "require"] as const) {
          const target = new URL(isolated.url);
          target.searchParams.set("sslmode", mode);
          const proxy = await commitCutProxy(target, { negotiationMs: 2000 });
          const client = postgres(proxy.url, {
            max: 1,
            prepare: false,
            onnotice: () => undefined,
            connect_timeout: 3,
          });
          const driver = postgres(target.href, {
            max: 1,
            prepare: false,
            onnotice: () => undefined,
            connect_timeout: 3,
          });
          const outcome = (sql: typeof client) =>
            sql`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`.then(
              ([r]) => (r?.ssl === false ? "plaintext" : "tls"),
              () => "refused",
            );
          try {
            const expected = mode === "require" ? "refused" : "plaintext";
            expect({ mode, proxy: await outcome(client) }).toEqual({
              mode,
              proxy: expected,
            });
            expect({ mode, driver: await outcome(driver) }).toEqual({
              mode,
              driver: expected,
            });
          } finally {
            await client.end({ timeout: 1 }).catch(() => undefined);
            await driver.end({ timeout: 1 }).catch(() => undefined);
            await proxy.close();
          }
        }
      } finally {
        await direct.end();
      }
    },
    20_000,
  );

  test.skipIf(!configured)(
    "gives up on a Clerk call that does not answer",
    async () => {
      devices.setEnrollmentTiming({ clerkMs: 200 });
      fake.stall = new Promise<void>(() => undefined);
      const begun = Date.now();
      const stalled = await enroll(oauthToken());
      expect(Date.now() - begun).toBeLessThan(2000);
      expect(stalled.status).toBe(503);
      expect(await stalled.json()).toMatchObject({ code: "issuance_failed" });
      expect(await rows()).toEqual([{ key_state: "ambiguous", active: false }]);
      fake.stall = null;
      expect((await enroll(oauthToken())).status).toBe(201);
      expect(await rows()).toEqual([
        { key_state: "ambiguous", active: false },
        { key_state: "issued", active: true },
      ]);
    },
  );

  test.skipIf(!configured)(
    "limits installations by their active keys, counting the one enrolling",
    async () => {
      for (const n of [1, 2]) await enrolled(otherInstallation(n));
      // A third installation fits.
      await enrolled();
      const before = fake.keys.map((k) => ({ ...k }));
      const recorded = await rows();
      const token = oauthToken();
      const fourth = await enroll(token, {
        installationId: otherInstallation(3),
        deviceName: "Fourth iPhone",
      });
      expect(fourth.status).toBe(409);
      expect(await fourth.json()).toMatchObject({ code: "device_limit" });
      expect(fake.keys).toEqual(before);
      expect(await rows()).toEqual(recorded);
      // The refusal left the token unused: replacing an enrolled
      // installation still fits, with the same token.
      expect((await enroll(token)).status).toBe(201);
    },
  );

  test.skipIf(!configured)(
    "never counts or accepts a key that appears late",
    async () => {
      for (const n of [1, 2]) await enrolled(otherInstallation(n));
      fake.create = "late";
      const late = await enroll(oauthToken(), {
        installationId: otherInstallation(3),
        deviceName: "Third iPhone",
      });
      expect(late.status).toBe(503);
      fake.create = "ok";
      // The late attempt holds no installation, so another one fits.
      await enrolled();
      fake.appear();
      const [lateKey] = activeFor(otherInstallation(3));
      if (!lateKey) throw new Error("Expected the late key.");
      // Three installations hold keys, whatever Clerk lists.
      const fourth = await enroll(oauthToken(), {
        installationId: otherInstallation(4),
        deviceName: "Fourth iPhone",
      });
      expect(fourth.status).toBe(409);
      const refused = await importWith(lateKey.secret);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: "key_invalid" });
      expect(lateKey.revoked).toBe(true);
    },
  );

  test.skipIf(!configured)(
    "refuses a late key that appears after its replacement",
    async () => {
      fake.create = "late";
      expect((await enroll(oauthToken())).status).toBe(503);
      fake.create = "ok";
      const current = await enrolled();
      fake.appear();
      expect(activeFor(installation)).toHaveLength(2);
      const late = activeFor(installation).find((k) => k.secret !== current);
      if (!late) throw new Error("Expected the late key.");
      const refused = await importWith(late.secret);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: "key_invalid" });
      expect(late.revoked).toBe(true);
      expect((await importWith(current)).status).toBe(200);
      expect(await rows()).toEqual([
        { key_state: "ambiguous", active: false },
        { key_state: "issued", active: true },
      ]);
    },
  );

  test.skipIf(!configured)(
    "limits keys created in an hour in Postgres, counting unconfirmed ones",
    async () => {
      for (let n = 0; n < 4; n++) await enrolled();
      // A fifth creation whose result Clerk never confirmed.
      fake.create = "late";
      expect((await enroll(oauthToken())).status).toBe(503);
      fake.create = "ok";
      const before = fake.keys.map((k) => ({ ...k }));
      const token = oauthToken();
      const sixth = await enroll(token);
      expect(sixth.status).toBe(429);
      expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(3000);
      expect(await sixth.json()).toMatchObject({ code: "rate_limited" });
      expect(fake.keys).toEqual(before);
      // Clerk's own list does not count: the late key appears, then the
      // oldest attempt leaves the hour.
      fake.appear();
      await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '2 hours', charged_at = now() - interval '2 hours' WHERE owner_id=${owner} AND created_at = (SELECT min(created_at) FROM fitness_device_enrollments WHERE owner_id=${owner})`;
      // The refusal left the token unused.
      expect((await enroll(token)).status).toBe(201);
    },
  );

  test.skipIf(!configured)(
    "frees an installation's place when its key is revoked or deleted in Clerk",
    async () => {
      for (const n of [1, 2, 3]) await enrolled(otherInstallation(n));
      const fourth = {
        installationId: otherInstallation(4),
        deviceName: "Fourth iPhone",
      };
      expect((await enroll(oauthToken(), fourth)).status).toBe(409);
      // Revoked under Manage account → API keys.
      const [revoked] = activeFor(otherInstallation(1));
      if (!revoked) throw new Error("Expected the key.");
      revoked.revoked = true;
      expect((await enroll(oauthToken(), fourth)).status).toBe(201);
      // Deleted from Clerk entirely.
      const [deleted] = activeFor(otherInstallation(2));
      fake.keys = fake.keys.filter((k) => k !== deleted);
      expect(
        (
          await enroll(oauthToken(), {
            installationId: otherInstallation(5),
            deviceName: "Fifth iPhone",
          })
        ).status,
      ).toBe(201);
      const active =
        await database()`SELECT installation_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND active ORDER BY installation_id`;
      expect(active.map((r) => r.installation_id)).toEqual(
        [3, 4, 5].map(otherInstallation),
      );
    },
  );

  test.skipIf(!configured)(
    "charges the hourly limit from when each key was created",
    async () => {
      // Recorded 70 minutes ago, but Clerk created the keys 50 minutes ago.
      const insert = (charged: string | null, state: string, age: string) =>
        database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,key_state,charged_at,created_at) VALUES(${owner},${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")},${crypto.randomUUID()},${otherInstallation(9)},${state},${charged === null ? null : database()`now() - ${charged}::interval`},now() - ${age}::interval)`;
      await database()`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      for (let n = 0; n < 4; n++)
        await insert("50 minutes", "issued", "70 minutes");
      // An attempt whose creation is unconfirmed counts from when it was recorded.
      await insert(null, "ambiguous", "90 minutes");
      const limited = await enroll(oauthToken());
      expect(limited.status).toBe(429);
      const wait = Number(limited.headers.get("retry-after"));
      // The soonest to leave is a key charged 50 minutes ago.
      expect(wait).toBeGreaterThan(9 * 60);
      expect(wait).toBeLessThanOrEqual(10 * 60 + 1);
      // Until its 24-hour bound, the ambiguous attempt still counts; past
      // it, it stops counting.
      await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '23 hours' WHERE owner_id=${owner} AND key_state='ambiguous'`;
      expect((await enroll(oauthToken())).status).toBe(429);
      await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '24 hours 1 minute' WHERE owner_id=${owner} AND key_state='ambiguous'`;
      expect((await enroll(oauthToken())).status).toBe(201);
    },
  );

  test.skipIf(!configured)(
    "keeps a valid key active when a changing list hides it",
    async () => {
      const kept = await enrolled(otherInstallation(1));
      const [keptKey] = activeFor(otherInstallation(1));
      if (!keptKey) throw new Error("Expected the key.");
      // Two unrelated keys sort ahead of it, one older after it.
      const later = Date.now() + 60_000;
      const [first] = [
        fake.addKey({ secret: "ak_newest", createdAt: later + 1000 }),
        fake.addKey({ secret: "ak_newer", createdAt: later }),
        fake.addKey({
          secret: "ak_older",
          createdAt: keptKey.createdAt - 1000,
        }),
      ];
      fake.pageSize = 2;
      // Deleting a key on the first page shifts the device key out of view.
      let calls = 0;
      fake.afterList = () => {
        if (++calls === 1) fake.keys = fake.keys.filter((k) => k !== first);
      };
      expect((await enrolled(otherInstallation(2))) === kept).toBe(false);
      expect(keptKey.revoked).toBe(false);
      expect((await importWith(kept)).status).toBe(200);
      const active =
        await database()`SELECT installation_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND active ORDER BY installation_id`;
      expect(active.map((r) => r.installation_id)).toEqual(
        [1, 2].map(otherInstallation),
      );
    },
  );

  test.skipIf(!configured)(
    "changes nothing when Clerk cannot say whether a key exists",
    async () => {
      const kept = await enrolled(otherInstallation(1));
      const [keptKey] = activeFor(otherInstallation(1));
      if (!keptKey) throw new Error("Expected the key.");
      fake.getFails.add(keptKey.id);
      const before = await rows();
      const response = await enroll(oauthToken());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
      expect(await rows()).toEqual(before);
      expect((await importWith(kept)).status).toBe(200);
    },
  );

  test.skipIf(!configured)(
    "keeps a key active on a 404 without Clerk's not-found error",
    async () => {
      const kept = await enrolled(otherInstallation(1));
      const [keptKey] = activeFor(otherInstallation(1));
      if (!keptKey) throw new Error("Expected the key.");
      fake.gatewayMissing.add(keptKey.id);
      const before = await rows();
      const response = await enroll(oauthToken());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
      expect(await rows()).toEqual(before);
      expect((await importWith(kept)).status).toBe(200);
      // Clerk's own not-found answer frees the place.
      fake.gatewayMissing.clear();
      fake.keys = fake.keys.filter((k) => k !== keptKey);
      expect((await enroll(oauthToken())).status).toBe(201);
      expect((await rows()).filter((r) => r.active).length).toBe(1);
    },
  );

  test.skipIf(!configured)(
    "skips a stalled key list and goes on with the enrollment",
    async () => {
      const current = await enrolled();
      fake.listStall = new Promise<void>(() => undefined);
      devices.setEnrollmentTiming({ cleanupMs: 300 });
      const calls = fake.listCalls;
      const begun = performance.now();
      const replaced = await enroll(oauthToken());
      expect(fake.listCalls).toBe(calls + 1);
      expect(performance.now() - begun).toBeLessThan(3000);
      expect(replaced.status).toBe(201);
      expect((await importWith(current)).status).toBe(401);
    },
  );

  test.skipIf(!configured)(
    "uses no token when recording waits on an import longer than its lock wait",
    async () => {
      const previous = await enrolled();
      const importer = postgres(isolated.url, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      store.setEnrollmentWait(300);
      try {
        const token = oauthToken();
        const before = await rows();
        // An import holds the account row, so recording waits on it.
        const held = holdAccount(importer);
        await held.taken;
        const response = await enroll(token);
        held.release();
        await held.done;
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("10");
        expect(await response.json()).toMatchObject({
          code: "issuance_pending",
        });
        expect(await rows()).toEqual(before);
        expect((await importWith(previous)).status).toBe(200);
        // The token was not used, so it enrolls once nothing waits.
        store.setEnrollmentWait();
        expect((await enroll(token)).status).toBe(201);
      } finally {
        store.setEnrollmentWait();
        await importer.end();
      }
    },
  );

  test.skipIf(!configured)(
    "keeps the new key when the swap's commit reply is lost",
    async () => {
      const previous = await enrolled();
      const original = store.swapEnrollment;
      // The swap commits, then its connection drops before the reply.
      const lostReply: typeof original = async (...args) => {
        await original(...args);
        throw new store.CommitOutcomeUnknown(new Error("Connection closed"));
      };
      const spy = spyOn(store, "swapEnrollment").mockImplementation(lostReply);
      let response: Response;
      try {
        response = await enroll(oauthToken());
      } finally {
        spy.mockRestore();
      }
      expect(response.status).toBe(201);
      const secret = (await response.json()).secret;
      const key = fake.keys.find((k) => k.secret === secret);
      expect(key?.revoked).toBe(false);
      // Recovery revoked the replaced key in Clerk after the swap.
      expect(fake.keys.find((k) => k.secret === previous)?.revoked).toBe(true);
      expect((await importWith(secret)).status).toBe(200);
      const old = await importWith(previous);
      expect(old.status).toBe(401);
      expect(await old.json()).toMatchObject({ code: "key_invalid" });
    },
  );

  test.skipIf(!configured)(
    "leaves the new key in place when the swap's outcome cannot be read",
    async () => {
      await enrolled();
      const originalSwap = store.swapEnrollment;
      const lostReply: typeof originalSwap = async (...args) => {
        await originalSwap(...args);
        throw new store.CommitOutcomeUnknown(new Error("Connection closed"));
      };
      const swap = spyOn(store, "swapEnrollment").mockImplementation(lostReply);
      const reread = spyOn(store, "swapOutcome").mockRejectedValue(
        new Error("Connection refused"),
      );
      let response: Response;
      try {
        response = await enroll(oauthToken());
      } finally {
        swap.mockRestore();
        reread.mockRestore();
      }
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "issuance_failed" });
      // The newest key, the one this enrollment created, was not revoked.
      const newest = fake.keys.reduce((a, b) =>
        a.createdAt >= b.createdAt ? a : b,
      );
      expect(newest.claims?.enrollment).toEqual(expect.any(String));
      expect(newest.revoked).toBe(false);
    },
  );

  test.skipIf(!configured)(
    "revokes the new key when a commit failure leaves the swap undone",
    async () => {
      const previous = await enrolled();
      const sql = database();
      // A check that fails only at COMMIT, so the commit's outcome is
      // unknown to the swap and the row has to be read again.
      await sql.unsafe(`
        CREATE TABLE fitness_test_commit_failures (on_commit boolean);
        INSERT INTO fitness_test_commit_failures VALUES (true);
        CREATE FUNCTION fitness_test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.active AND EXISTS (SELECT 1 FROM fitness_test_commit_failures) THEN
            RAISE EXCEPTION 'synthetic commit failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE CONSTRAINT TRIGGER fitness_test_fail_commit AFTER UPDATE ON fitness_device_enrollments
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fitness_test_fail_commit();`);
      const original = store.swapOutcome;
      const outcomes: string[] = [];
      const counted = spyOn(store, "swapOutcome").mockImplementation(
        async (...args) => {
          const outcome = await original(...args);
          outcomes.push(outcome.outcome);
          return outcome;
        },
      );
      let response: Response;
      try {
        response = await enroll(oauthToken());
      } finally {
        counted.mockRestore();
        await sql.unsafe(`
          DROP TRIGGER fitness_test_fail_commit ON fitness_device_enrollments;
          DROP FUNCTION fitness_test_fail_commit();
          DROP TABLE fitness_test_commit_failures;`);
      }
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "issuance_failed" });
      // The commit error reached the recovery read, which found it undone.
      expect(outcomes).toEqual(["undone"]);
      expect((await importWith(previous)).status).toBe(200);
      expect((await rows()).filter((r) => r.active)).toHaveLength(1);
      // Clerk made the key, so the failed attempt still counts toward the
      // hourly limit.
      const [failedAttempt] =
        await database()`SELECT key_state, charged_at IS NOT NULL AS charged FROM fitness_device_enrollments WHERE owner_id=${owner} AND NOT active ORDER BY created_at DESC LIMIT 1`;
      expect({ ...failedAttempt }).toEqual({
        key_state: "failed",
        charged: true,
      });
      const newest = fake.keys.reduce((a, b) =>
        a.createdAt >= b.createdAt ? a : b,
      );
      expect(newest.revoked).toBe(true);
    },
  );

  test.skipIf(!configured)(
    "waits for a swap whose connection drops while it is still committing",
    async () => {
      const previous = await enrolled();
      const sql = database();
      // The lock key and the connections' application name belong to this
      // run, so runs sharing a database never wait on or watch each other.
      const lockKey = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
      const application = `fitness_commit_cut_${crypto.randomUUID()}`;
      // The name goes in the URL, where it wins over any the test URL has.
      const runUrl = new URL(isolated.url);
      runUrl.searchParams.set("application_name", application);
      // COMMIT runs a deferred trigger that waits for an advisory lock the
      // test holds, so the swap keeps its rows locked until the test lets
      // the commit finish.
      await sql.unsafe(`
        CREATE FUNCTION fitness_test_held_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.active THEN
            PERFORM pg_advisory_xact_lock(${lockKey});
          END IF;
          RETURN NEW;
        END $$;
        CREATE CONSTRAINT TRIGGER fitness_test_held_commit AFTER UPDATE ON fitness_device_enrollments
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fitness_test_held_commit();`);
      const locker = postgres(runUrl.href, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      const [held] =
        await locker`SELECT pg_backend_pid() AS pid, pg_advisory_lock(${lockKey})`;
      let locked = true;
      const unlock = async () => {
        if (!locked) return;
        locked = false;
        await locker`SELECT pg_advisory_unlock(${lockKey})`;
      };
      const proxy = await commitCutProxy(runUrl);
      const pool = postgres(proxy.url, {
        max: 3,
        prepare: false,
        onnotice: () => undefined,
      });
      const originalSwap = store.swapEnrollment;
      const arming = spyOn(store, "swapEnrollment").mockImplementation(
        async (...args) => {
          proxy.arm();
          return originalSwap(...args);
        },
      );
      const originalOutcome = store.swapOutcome;
      const outcomes: string[] = [];
      const counted = spyOn(store, "swapOutcome").mockImplementation(
        async (...args) => {
          const outcome = await originalOutcome(...args);
          outcomes.push(outcome.outcome);
          return outcome;
        },
      );
      setDatabaseForTests(pool);
      let pending: Promise<Response> | undefined;
      let response: Response;
      try {
        pending = enroll(oauthToken());
        // The swap's COMMIT waits for the test's lock, and the recovery
        // read waits for the committing swap.
        const committing = await blockedBy(
          Number(held?.pid),
          application,
          "commit",
        );
        await blockedBy(
          committing,
          application,
          "SELECT key_state, active, key_id",
        );
        expect(proxy.cuts).toBe(1);
        await unlock();
        response = await pending;
      } finally {
        await unlock();
        await pending?.catch(() => undefined);
        arming.mockRestore();
        counted.mockRestore();
        setDatabaseForTests(isolated.pool());
        await pool.end({ timeout: 1 }).catch(() => undefined);
        await proxy.close();
        await locker.end();
        await sql.unsafe(`
          DROP TRIGGER fitness_test_held_commit ON fitness_device_enrollments;
          DROP FUNCTION fitness_test_held_commit();`);
      }
      // The recovery read waited for the commit and found it.
      expect(outcomes).toEqual(["committed"]);
      expect(response.status).toBe(201);
      const secret = (await response.json()).secret;
      expect(fake.keys.find((k) => k.secret === secret)?.revoked).toBe(false);
      expect(fake.keys.find((k) => k.secret === previous)?.revoked).toBe(true);
      expect((await importWith(secret)).status).toBe(200);
      const refused = await importWith(previous);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: "key_invalid" });
    },
    20_000,
  );

  test.skipIf(!configured)(
    "keeps the current key when the create fails",
    async () => {
      const previous = await enrolled();
      fake.create = "fail";
      const failed = await enroll(oauthToken());
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ code: "issuance_failed" });
      expect((await importWith(previous)).status).toBe(200);
      expect((await rows()).filter((r) => r.active)).toHaveLength(1);
    },
  );

  test.skipIf(!configured)(
    "reads every page of keys before cleaning up",
    async () => {
      fake.pageSize = 2;
      for (let n = 0; n < 5; n++)
        fake.addKey({
          secret: `ak_unrelated_${n}`,
          createdAt: Date.now() - 7200_000,
        });
      const stale = fake.addKey({
        secret: "ak_stale",
        scopes: ["fitness:health:import"],
        claims: { kind: "fitness-ios", installationId: installation },
        createdAt: Date.now() - 7200_000 - 1,
      });
      expect((await enroll(oauthToken())).status).toBe(201);
      expect(fake.listCalls).toBeGreaterThan(2);
      expect(stale.revoked).toBe(true);
      expect(activeFor(installation)).toHaveLength(1);
    },
  );

  test.skipIf(!configured)(
    "keeps a token used after Clerk fails to create the key",
    async () => {
      const token = oauthToken();
      fake.create = "fail";
      const failed = await enroll(token);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ code: "issuance_failed" });
      fake.create = "ok";
      const retry = await enroll(token);
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({
        code: "enrollment_token_used",
      });
      expect((await enroll(oauthToken())).status).toBe(201);
      expect(await rows()).toEqual([
        { key_state: "ambiguous", active: false },
        { key_state: "issued", active: true },
      ]);
    },
  );

  test.skipIf(!configured)(
    "revokes a key whose creation reply was lost on the next enrollment",
    async () => {
      fake.create = "lost";
      const lost = await enroll(oauthToken());
      expect(lost.status).toBe(503);
      const [orphan] = activeFor(installation);
      if (!orphan) throw new Error("Expected the orphaned key.");
      expect((await importWith(orphan.secret)).status).toBe(401);
      // A fresh orphan, since the import above revoked the first.
      expect((await enroll(oauthToken())).status).toBe(503);
      const [second] = activeFor(installation);
      fake.create = "ok";
      expect((await enroll(oauthToken())).status).toBe(201);
      expect(second?.revoked).toBe(true);
      expect(activeFor(installation)).toHaveLength(1);
    },
  );

  test.skipIf(!configured)(
    "stops an old key importing even when Clerk cannot revoke it",
    async () => {
      const old = await enrolled();
      const oldKey = fake.keys.find((k) => k.secret === old);
      if (!oldKey) throw new Error("Expected the key.");
      fake.revokeFails.add(oldKey.id);
      const current = await enrolled();
      expect(oldKey.revoked).toBe(false);
      const refused = await importWith(old);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: "key_invalid" });
      expect((await importWith(current)).status).toBe(200);
    },
  );

  test.skipIf(!configured)(
    "removes inactive token records after two days",
    async () => {
      const old = "0".repeat(64);
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,key_state,created_at) VALUES(${owner},${old},${crypto.randomUUID()},${otherInstallation(1)},'failed',now() - interval '3 days')`;
      const active = await enrolled(otherInstallation(2));
      await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '3 days' WHERE owner_id=${owner} AND installation_id=${otherInstallation(2)} AND active`;
      await enrolled();
      const kept =
        await database()`SELECT token_digest FROM fitness_device_enrollments WHERE owner_id=${owner} AND created_at < now() - interval '2 days'`;
      expect(kept).toHaveLength(1);
      expect(kept[0]?.token_digest).not.toBe(old);
      expect((await importWith(active)).status).toBe(200);
    },
  );

  test.skipIf(!configured)(
    "checks the enrollment table and its access on every readiness check",
    async () => {
      // A schema and role of their own, so shared tables are never touched.
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const schema = "fitness_ready_" + suffix;
      const role = "fitness_ready_" + suffix;
      const sql = database();
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic'`);
      const url = new URL(process.env.FITNESS_TEST_DATABASE_URL ?? "");
      const connect = (user?: string) => {
        const target = new URL(url);
        if (user) {
          target.username = user;
          target.password = "synthetic";
        }
        return postgres(target.href, {
          max: 1,
          prepare: false,
          onnotice: () => undefined,
          connection: { search_path: schema },
        });
      };
      const admin = connect();
      const limited = connect(role);
      try {
        expect(await devices.deviceEnrollmentReady(admin)).toBe(false);
        await admin.unsafe(
          await Bun.file(new URL("../schema.sql", import.meta.url)).text(),
        );
        expect(await devices.deviceEnrollmentReady(admin)).toBe(true);
        await admin.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
        );
        expect(await devices.deviceEnrollmentReady(limited)).toBe(false);
        await admin.unsafe(
          `GRANT INSERT, UPDATE, DELETE ON ${schema}.fitness_device_enrollments TO ${role}; GRANT INSERT, UPDATE ON ${schema}.fitness_device_attempt_windows TO ${role}; GRANT INSERT ON ${schema}.fitness_accounts TO ${role}`,
        );
        // Pruning old attempt windows needs DELETE too.
        expect(await devices.deviceEnrollmentReady(limited)).toBe(false);
        await admin.unsafe(
          `GRANT DELETE ON ${schema}.fitness_device_attempt_windows TO ${role}`,
        );
        // Locking the account with SELECT ... FOR UPDATE needs UPDATE.
        expect(await devices.deviceEnrollmentReady(limited)).toBe(false);
        await admin.unsafe(
          `GRANT UPDATE ON ${schema}.fitness_accounts TO ${role}`,
        );
        expect(await devices.deviceEnrollmentReady(limited)).toBe(true);
        // A role readiness accepts can record and swap in a key.
        const attemptId = crypto.randomUUID();
        setDatabaseForTests(limited);
        try {
          expect(
            await store.recordEnrollment(
              owner,
              {
                tokenId: "oat_id_limited_role",
                digest: "7".repeat(64),
                attemptId,
                installationId: installation,
                enrollmentSequence: 1,
              },
              { installations: 3, perHour: 5 },
            ),
          ).toBeNull();
          expect(
            await store.swapEnrollment(
              owner,
              {
                attemptId,
                installationId: installation,
                keyId: "ak_id_limited_role",
              },
              { installations: 3 },
            ),
          ).toEqual({ activated: true, replaced: [], reason: null });
        } finally {
          setDatabaseForTests(isolated.pool());
        }
        await admin`DROP TABLE fitness_device_enrollments CASCADE`;
        expect(await devices.deviceEnrollmentReady(admin)).toBe(false);
      } finally {
        await limited.end();
        await admin.end();
        await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await sql.unsafe(`DROP OWNED BY ${role}`);
        await sql.unsafe(`DROP ROLE ${role}`);
      }
      expect(await devices.deviceEnrollmentReady()).toBe(true);
    },
  );
});

describe("device attempt windows and contention", () => {
  const url = isolated.url;
  const client = () =>
    postgres(url, { max: 2, prepare: false, onnotice: () => undefined });

  test.skipIf(!configured)(
    "counts attempts across independent clients and stops at the cap",
    async () => {
      // This suite's own schema, so clearing the windows touches no one else.
      await database()`DELETE FROM fitness_device_attempt_windows`;
      const [a, b] = [client(), client()];
      try {
        const results = [];
        for (const sql of [a, b, a, b, a])
          results.push(await store.countEnrollmentAttempt(3, sql));
        const windows =
          await database()`SELECT attempts FROM fitness_device_attempt_windows`;
        // Unless the minute turned over between calls.
        if (windows.length === 1) {
          expect(results.map((r) => r.allowed)).toEqual([
            true,
            true,
            true,
            false,
            false,
          ]);
          expect(windows[0]?.attempts).toBe(3);
        }
        for (const result of results) {
          expect(result.wait).toBeGreaterThan(0);
          expect(result.wait).toBeLessThanOrEqual(60);
        }
        // Over the shared limit, enrollment refuses before calling Clerk.
        devices.setSharedEnrollmentLimit(0);
        const limited = await enroll(oauthToken());
        expect(limited.status).toBe(429);
        expect(await limited.json()).toMatchObject({ code: "rate_limited" });
        expect(fake.requests).toHaveLength(0);
      } finally {
        await Promise.all([a.end(), b.end()]);
      }
    },
  );

  test.skipIf(!configured)(
    "never leaves two active keys while a swap waits behind an import",
    async () => {
      await database()`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      const current = crypto.randomUUID();
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,key_state,key_id,active,charged_at,enrollment_sequence) VALUES(${owner},${"d".repeat(64)},${current},${installation},'issued','ak_id_current',true,now(),1)`;
      const next = crypto.randomUUID();
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,enrollment_sequence) VALUES(${owner},${"e".repeat(64)},${next},${installation},2)`;
      const active = async () =>
        (
          await database()`SELECT attempt_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND active`
        ).map((r) => r.attempt_id);
      // An import holds the account and reads the current key, as it does
      // before it saves; the swap waits behind it.
      const importer = client();
      let swapping: ReturnType<typeof store.swapEnrollment> | undefined;
      try {
        await importer.begin(async (tx) => {
          await tx`SELECT owner_id FROM fitness_accounts WHERE owner_id=${owner} FOR UPDATE`;
          await tx`SELECT 1 FROM fitness_device_enrollments WHERE attempt_id=${current} FOR SHARE`;
          swapping = store.swapEnrollment(
            owner,
            {
              attemptId: next,
              installationId: installation,
              keyId: "ak_id_second",
            },
            { installations: 3 },
          );
          await lockWaiters();
          expect(await active()).toEqual([current]);
        });
        // Once the import commits, the swap stops the current key and
        // activates the next one together.
        expect(await swapping).toEqual({
          activated: true,
          replaced: ["ak_id_current"],
          reason: null,
        });
        expect(await active()).toEqual([next]);
        // An attempt that is no longer pending is never activated.
        await database()`UPDATE fitness_device_enrollments SET key_state='failed' WHERE attempt_id=${current}`;
        expect(
          await store.swapEnrollment(
            owner,
            {
              attemptId: current,
              installationId: installation,
              keyId: "ak_id_current",
            },
            { installations: 3 },
          ),
        ).toEqual({ activated: false, replaced: [], reason: "not_pending" });
        expect(await active()).toEqual([next]);
        // Nor is one that would put more installations than the limit on
        // active keys.
        const extra = crypto.randomUUID();
        await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id) VALUES(${owner},${"c".repeat(64)},${extra},${otherInstallation(1)})`;
        expect(
          await store.swapEnrollment(
            owner,
            {
              attemptId: extra,
              installationId: otherInstallation(1),
              keyId: "ak_id_extra",
            },
            { installations: 1 },
          ),
        ).toEqual({ activated: false, replaced: [], reason: "device_limit" });
        expect(await active()).toEqual([next]);
      } finally {
        await importer.end();
      }
    },
  );

  test.skipIf(!configured)(
    "refuses an attempt over the cap without waiting on the counter",
    async () => {
      await database()`DELETE FROM fitness_device_attempt_windows`;
      store.forgetFullAttemptWindow();
      const cap = 2;
      expect((await store.countEnrollmentAttempt(cap)).allowed).toBe(true);
      expect((await store.countEnrollmentAttempt(cap)).allowed).toBe(true);
      const locker = client();
      try {
        await locker.begin(async (tx) => {
          // Another server holds the full window's row.
          await tx`SELECT 1 FROM fitness_device_attempt_windows FOR UPDATE`;
          for (const remembered of [false, true]) {
            if (!remembered) store.forgetFullAttemptWindow();
            const begun = performance.now();
            const result = await store.countEnrollmentAttempt(cap);
            expect(result.allowed).toBe(false);
            expect(performance.now() - begun).toBeLessThan(500);
          }
        });
        const [window] =
          await database()`SELECT attempts FROM fitness_device_attempt_windows`;
        // Unless the minute turned over during the test.
        if (window) expect(window.attempts).toBeLessThanOrEqual(cap);
      } finally {
        await locker.end();
        store.forgetFullAttemptWindow();
      }
    },
  );

  test.skipIf(!configured)("checks readiness in one query", async () => {
    const queries: string[] = [];
    const counted = postgres(url, {
      max: 1,
      prepare: false,
      // Type lookups on connect are the driver's own, not readiness checks.
      fetch_types: false,
      onnotice: () => undefined,
      debug: (_connection, query) => {
        queries.push(query);
      },
    });
    try {
      expect(await devices.deviceEnrollmentReady(counted)).toBe(true);
      expect(queries).toHaveLength(1);
    } finally {
      await counted.end();
    }
  });
});

describe("device import against a reconnect", () => {
  /**
   * Holds an import inside its transaction, after it takes the account lock
   * and before it reads its device key, until released.
   */
  function importInsideItsLock(secret: string) {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => undefined as void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const original = store.changeHealth;
    const paused: typeof original = (owner, work) =>
      original(owner, async (change) => {
        reached();
        await gate;
        return work(change);
      });
    const spy = spyOn(store, "changeHealth").mockImplementation(paused);
    const response = importWith(secret).finally(() => spy.mockRestore());
    return { response, waiting, release };
  }
  /** A fresh account each round, so the hourly limit stays out of it. */
  async function freshRound() {
    await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
    fake.keys = [];
  }
  const activeRows = async () =>
    (
      await database()`SELECT attempt_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND active`
    ).length;

  test.skipIf(!configured)(
    "commits an import that holds the account before the reconnect",
    async () => {
      for (let round = 0; round < 3; round++) {
        await freshRound();
        const secret = await enrolled();
        const paused = importInsideItsLock(secret);
        await paused.waiting;
        const reconnect = enroll(oauthToken());
        // The reconnect waits on the account row the import holds.
        await lockWaiters();
        paused.release();
        const [imported, reconnected] = await Promise.all([
          paused.response,
          reconnect,
        ]);
        expect(imported.status).toBe(200);
        expect(reconnected.status).toBe(201);
        expect(await activeRows()).toBe(1);
        expect((await importWith(secret)).status).toBe(401);
      }
    },
    30_000,
  );

  test.skipIf(!configured)(
    "refuses an import that reaches the account after the swap",
    async () => {
      const locker = postgres(isolated.url, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      try {
        for (let round = 0; round < 3; round++) {
          await freshRound();
          const secret = await enrolled();
          let releaseCreate = () => undefined as void;
          fake.stall = new Promise<void>((resolve) => {
            releaseCreate = resolve;
          });
          const creating = new Promise<void>((resolve) => {
            fake.onCreate = resolve;
          });
          const reconnect = enroll(oauthToken());
          await creating;
          // The swap queues on the account row first, then the import.
          const held = holdAccount(locker);
          await held.taken;
          releaseCreate();
          await lockWaiters(1);
          const imported = importWith(secret);
          await lockWaiters(2);
          held.release();
          await held.done;
          const [reconnected, refused] = await Promise.all([
            reconnect,
            imported,
          ]);
          fake.stall = null;
          fake.onCreate = null;
          expect(reconnected.status).toBe(201);
          expect(refused.status).toBe(401);
          expect(await refused.json()).toMatchObject({ code: "key_invalid" });
          expect(await activeRows()).toBe(1);
        }
      } finally {
        fake.stall = null;
        fake.onCreate = null;
        await locker.end();
      }
    },
    30_000,
  );
});

describe("device import against a disconnect", () => {
  /** Holds an authenticated import before its transaction until released. */
  function pausedImport(secret: string) {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => undefined as void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const original = store.changeHealth;
    const paused: typeof original = async (owner, work) => {
      reached();
      await gate;
      return original(owner, work);
    };
    const spy = spyOn(store, "changeHealth").mockImplementation(paused);
    const response = importWith(secret).finally(() => spy.mockRestore());
    return { response, waiting, release };
  }

  test.skipIf(!configured)(
    "saves nothing when the key is disconnected mid-import",
    async () => {
      const secret = await enrolled();
      const before = await loadRecords(owner);
      const paused = pausedImport(secret);
      await paused.waiting;
      const disconnected = await devices.handleDeviceRevoke(
        bearer(secret, { method: "DELETE" }, "/api/health/devices/current"),
      );
      expect(disconnected.status).toBe(204);
      paused.release();
      const response = await paused.response;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "key_invalid" });
      expect(await loadRecords(owner)).toEqual(before);
    },
  );

  test.skipIf(!configured)(
    "saves nothing when the key is replaced mid-import",
    async () => {
      const secret = await enrolled();
      const before = await loadRecords(owner);
      const paused = pausedImport(secret);
      await paused.waiting;
      await enrolled();
      paused.release();
      const response = await paused.response;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "key_invalid" });
      expect(await loadRecords(owner)).toEqual(before);
    },
  );
});

describe("enrollment schema", () => {
  test.skipIf(!configured)(
    "upgrades an earlier enrollment table in place and keeps used tokens",
    async () => {
      const schema =
        "fitness_upgrade_" + crypto.randomUUID().replaceAll("-", "");
      await database().unsafe(`CREATE SCHEMA ${schema}`);
      const isolated = postgres(process.env.FITNESS_TEST_DATABASE_URL ?? "", {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
        connection: { search_path: schema },
      });
      try {
        // The table as the first attempt-tracking version created it.
        await isolated.unsafe(`CREATE TABLE fitness_accounts (owner_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
${EARLIER_ENROLLMENTS}`);
        const digest = "a".repeat(64);
        await isolated`INSERT INTO fitness_accounts(owner_id) VALUES(${owner})`;
        await isolated`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,key_state) VALUES(${owner},${digest},${crypto.randomUUID()},${installation},'issued')`;
        const current = await Bun.file(
          new URL("../schema.sql", import.meta.url),
        ).text();
        await isolated.unsafe(current);
        await isolated.unsafe(current);
        const kept =
          await isolated`SELECT token_digest, key_state, active, charged_at = created_at AS charged FROM fitness_device_enrollments`;
        // An issued key counts toward the hourly limit from when it was recorded.
        expect(kept.map((r) => ({ ...r }))).toEqual([
          {
            token_digest: digest,
            key_state: "issued",
            active: false,
            charged: true,
          },
        ]);
        expect(await devices.deviceEnrollmentReady(isolated)).toBe(true);
        // The upgraded table takes the new state and enforces its rules.
        await isolated`UPDATE fitness_device_enrollments SET key_state='ambiguous'`;
        await expect(
          isolated`UPDATE fitness_device_enrollments SET active=true`,
        ).rejects.toThrow();
      } finally {
        await isolated.end();
        await database().unsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    },
  );
});

describe("device disconnect", () => {
  const disconnect = (secret: string) =>
    devices.handleDeviceRevoke(
      bearer(secret, { method: "DELETE" }, "/api/health/devices/current"),
    );

  test.skipIf(!configured)(
    "stops the key importing, revokes it, then reports it invalid",
    async () => {
      const secret = await enrolled();
      const response = await disconnect(secret);
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await rows()).toEqual([{ key_state: "issued", active: false }]);
      expect(fake.keys.find((k) => k.secret === secret)?.revoked).toBe(true);
      expect((await importWith(secret)).status).toBe(401);
      // A retry after a lost reply is definitive.
      const again = await disconnect(secret);
      expect(again.status).toBe(401);
      expect(await again.json()).toMatchObject({ code: "key_invalid" });
    },
  );

  test.skipIf(!configured)(
    "disconnects even when Clerk cannot revoke the key",
    async () => {
      const secret = await enrolled();
      const key = fake.keys.find((k) => k.secret === secret);
      if (!key) throw new Error("Expected the key.");
      fake.revokeFails.add(key.id);
      expect((await disconnect(secret)).status).toBe(204);
      expect(key.revoked).toBe(false);
      const refused = await importWith(secret);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: "key_invalid" });
      const again = await disconnect(secret);
      expect(again.status).toBe(401);
      expect(await again.json()).toMatchObject({ code: "key_invalid" });
    },
  );

  test.skipIf(!configured)("works while enrollment is turned off", async () => {
    const secret = await enrolled();
    process.env.FITNESS_DEVICE_ENROLLMENT = "disabled";
    expect((await disconnect(secret)).status).toBe(204);
  });

  test.skipIf(!configured)("refuses a key that is not active", async () => {
    fake.create = "late";
    expect((await enroll(oauthToken())).status).toBe(503);
    fake.appear();
    const [late] = activeFor(installation);
    if (!late) throw new Error("Expected the late key.");
    const response = await disconnect(late.secret);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "key_invalid" });
    expect(late.revoked).toBe(true);
  });
});

describe("device import", () => {
  const ref = (prefix: string, n: number) =>
    `${prefix}:0000000${n}-0000-4000-8000-00000000abcd`;
  function post(token: string, body: unknown) {
    return handleHealthImport(
      bearer(
        token,
        { method: "POST", body: JSON.stringify(body) },
        "/api/health/import",
      ),
      { now },
    );
  }
  const deviceKey = () => enrolled();
  const weighIns = (data: object[]) => ({
    data: { metrics: [{ name: "weight_body_mass", units: "kg", data }] },
  });
  const weighIn = (n: number, date: string, qty = 80) => ({
    ref: ref("w", n),
    date,
    qty,
  });

  test.skipIf(!configured)(
    "replies to each key class with its own reply",
    async () => {
      fake.addKey({ secret: "ak_owner" });
      fake.addKey({ secret: "ak_read", scopes: ["fitness:read"] });
      fake.addKey({ secret: "ak_write", scopes: ["fitness:write"] });
      const legacy = {
        data: {
          metrics: [
            {
              name: "weight_body_mass",
              units: "kg",
              data: [{ date: "2026-10-01 06:00:00 +1000", qty: 80 }],
            },
          ],
        },
      };
      // A bare key in the Authorization header works as it always has.
      const bareKey = await handleHealthImport(
        new Request("http://127.0.0.1:3025/api/health/import", {
          method: "POST",
          headers: { authorization: "ak_owner" },
          body: JSON.stringify(legacy),
        }),
        { now },
      );
      expect(bareKey.status).toBe(200);
      expect(await bareKey.json()).toMatchObject({
        added: { weights: 1, runs: 0 },
        weights: [{ date: "2026-10-01", status: "added" }],
      });
      const scopeless = await post("ak_owner", legacy);
      expect(await scopeless.json()).toMatchObject({
        added: { weights: 0, runs: 0 },
        weights: [{ date: "2026-10-01", status: "kept" }],
      });
      expect((await post("ak_read", legacy)).status).toBe(403);
      expect(await (await post("ak_write", legacy)).json()).toEqual({
        received: { weights: 1, runs: 0 },
      });
      const device = await post(
        await deviceKey(),
        weighIns([weighIn(1, "2026-10-01T06:00:00+10:00")]),
      );
      expect(await device.json()).toEqual({
        kind: "device",
        accountTimezone: timezone,
        outcomes: [
          {
            ref: ref("w", 1),
            type: "weight",
            result: "kept",
            code: "already_imported",
          },
        ],
      });
    },
  );

  test.skipIf(!configured)(
    "rejects the whole request for any entry it cannot read",
    async () => {
      const token = await deviceKey();
      const valid = weighIn(1, "2026-10-02T06:00:00+10:00");
      const run = {
        ref: ref("r", 1),
        name: "Running",
        start: "2026-10-02T06:00:00+10:00",
        duration: 1800,
        distance: { qty: 5, units: "km" },
      };
      const cases: [string, unknown, string][] = [
        [
          "missing ref",
          weighIns([valid, { date: valid.date, qty: 80 }]),
          "data.metrics.0.data.1.ref",
        ],
        [
          "malformed ref",
          weighIns([valid, { ...valid, ref: "w:1234" }]),
          "data.metrics.0.data.1.ref",
        ],
        [
          "duplicate ref in another case",
          weighIns([
            valid,
            {
              ...valid,
              ref: "w:" + valid.ref.slice(2).toUpperCase(),
              date: "2026-10-03T06:00:00+10:00",
            },
          ]),
          "data.metrics.0.data.1.ref",
        ],
        [
          "wrong type prefix",
          { data: { workouts: [{ ...run, ref: ref("w", 9) }] } },
          "data.workouts.0.ref",
        ],
        [
          "unsupported metric",
          {
            data: {
              metrics: [{ name: "step_count", units: "count", data: [] }],
            },
          },
          "data.metrics.0.name",
        ],
        [
          "unsupported workout",
          { data: { workouts: [{ ...run, name: "Walking" }] } },
          "data.workouts.0.name",
        ],
        [
          "non-numeric qty",
          weighIns([valid, { ...weighIn(2, valid.date), qty: "80" }]),
          "data.metrics.0.data.1.qty",
        ],
        [
          "unparseable date",
          weighIns([valid, weighIn(2, "2026-02-30T06:00:00+10:00")]),
          "data.metrics.0.data.1.date",
        ],
        [
          "bad units",
          {
            data: {
              metrics: [
                { name: "weight_body_mass", units: "oz", data: [valid] },
              ],
            },
          },
          "data.metrics.0.units",
        ],
        [
          "bad distance units",
          {
            data: {
              workouts: [{ ...run, distance: { qty: 5, units: "furlong" } }],
            },
          },
          "data.workouts.0.distance.units",
        ],
        [
          "no duration or end",
          { data: { workouts: [{ ...run, duration: undefined }] } },
          "data.workouts.0.duration",
        ],
      ];
      const before = await loadRecords(owner);
      for (const [name, body, path] of cases) {
        const response = await post(token, body);
        const json = await response.json();
        expect({ name, status: response.status, code: json.code }).toEqual({
          name,
          status: 400,
          code: "invalid_device_request",
        });
        expect({ name, error: json.error.split(":")[0] }).toEqual({
          name,
          error: path,
        });
      }
      expect(await loadRecords(owner)).toEqual(before);
    },
  );

  test.skipIf(!configured)(
    "checks the backfill timezone before saving",
    async () => {
      const token = await deviceKey();
      const body = {
        expectedTimezone: "Pacific/Auckland",
        ...weighIns([weighIn(3, "2026-10-04T06:00:00+10:00")]),
      };
      const before = await loadRecords(owner);
      const changed = await post(token, body);
      expect(changed.status).toBe(409);
      expect(await changed.json()).toEqual({
        error: expect.any(String),
        code: "timezone_changed",
        accountTimezone: timezone,
      });
      expect(await loadRecords(owner)).toEqual(before);
      const same = await post(token, { ...body, expectedTimezone: timezone });
      expect((await same.json()).outcomes).toEqual([
        { ref: ref("w", 3), type: "weight", result: "added", code: "new" },
      ]);
    },
  );

  test.skipIf(!configured)(
    "lets the first ref at an instant claim it, even when it is skipped",
    async () => {
      const token = await deviceKey();
      const id = (prefix: string, n: number) =>
        `${prefix}:${String(n).padStart(8, "0")}-2222-4333-8444-555566667777`;
      const run = (n: number, start: string, duration: number) => ({
        ref: id("r", n),
        name: "Running",
        start,
        duration,
        distance: { qty: 5, units: "km" },
      });
      const response = await post(token, {
        data: {
          metrics: [
            {
              name: "weight_body_mass",
              units: "kg",
              data: [
                // Skipped first, then a valid weigh-in at the same instant.
                { ref: id("w", 1), date: "2026-10-10T06:00:00+10:00", qty: 5 },
                { ref: id("w", 2), date: "2026-10-10T06:00:00+10:00", qty: 80 },
                // Valid first, then a skipped one at the same instant.
                { ref: id("w", 3), date: "2026-10-11T06:00:00+10:00", qty: 80 },
                {
                  ref: id("w", 4),
                  date: "2026-10-11T06:00:00+10:00",
                  qty: 900,
                },
              ],
            },
          ],
          workouts: [
            run(1, "2026-10-10T06:00:00+10:00", 0),
            run(2, "2026-10-10T06:00:00+10:00", 1800),
            run(3, "2026-10-11T06:00:00+10:00", 1800),
            run(4, "2026-10-11T06:00:00+10:00", 0),
          ],
        },
      });
      expect(response.status).toBe(200);
      const outcomes = (await response.json()).outcomes.map(
        (o: { ref: string; result: string; code: string }) => [
          o.ref.slice(0, 10),
          o.result,
          o.code,
        ],
      );
      expect(outcomes).toEqual([
        ["w:00000001", "skipped", "out_of_range"],
        ["w:00000002", "kept", "duplicate_in_request"],
        ["w:00000003", "added", "new"],
        ["w:00000004", "kept", "duplicate_in_request"],
        ["r:00000001", "skipped", "out_of_range"],
        ["r:00000002", "kept", "duplicate_in_request"],
        ["r:00000003", "added", "new"],
        ["r:00000004", "kept", "duplicate_in_request"],
      ]);
      const records = await loadRecords(owner);
      expect(
        records.some(
          (r) => r.data.kind === "weight" && r.data.date === "2026-10-10",
        ),
      ).toBe(false);
    },
  );

  test.skipIf(!configured)("limits samples and body size", async () => {
    const token = await deviceKey();
    const many = Array.from({ length: 2001 }, (_, i) => ({
      ref: `w:${crypto.randomUUID()}`,
      date: `2026-09-01T06:00:${String(i % 60).padStart(2, "0")}+10:00`,
      qty: 80,
    }));
    const tooMany = await post(token, weighIns(many));
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ code: "too_many_samples" });
    const large = await post(token, { padding: "x".repeat(4_000_001) });
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ code: "payload_too_large" });
  });

  test.skipIf(!configured)(
    "fails without saving when the reply would miss a ref",
    async () => {
      const token = await deviceKey();
      const check = spyOn(reply, "checkDeviceReply").mockImplementation(() => {
        throw new reply.DeviceReplyMismatch("A ref has no outcome.");
      });
      const before = await loadRecords(owner);
      try {
        const response = await post(
          token,
          weighIns([weighIn(5, "2026-10-06T06:00:00+10:00")]),
        );
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ code: "server_error" });
      } finally {
        check.mockRestore();
      }
      expect(await loadRecords(owner)).toEqual(before);
    },
  );

  test("finds a reply without one outcome per ref", () => {
    const submitted = [
      { ref: ref("w", 1), type: "weight" },
      { ref: ref("r", 1), type: "run" },
    ];
    const outcome = (r: string, type: "weight" | "run") => ({
      ref: r,
      type,
      result: "added" as const,
      code: "new" as const,
    });
    const answer = (outcomes: ReturnType<typeof outcome>[]) => ({
      kind: "device" as const,
      accountTimezone: timezone,
      outcomes,
    });
    expect(() =>
      reply.checkDeviceReply(
        submitted,
        answer([outcome(ref("w", 1), "weight"), outcome(ref("r", 1), "run")]),
      ),
    ).not.toThrow();
    for (const outcomes of [
      [outcome(ref("w", 1), "weight")],
      [outcome(ref("w", 1), "weight"), outcome(ref("r", 1), "weight")],
      [outcome(ref("w", 1), "weight"), outcome(ref("w", 1), "weight")],
      [
        outcome(ref("w", 1), "weight"),
        outcome(ref("r", 1), "run"),
        outcome(ref("r", 2), "run"),
      ],
    ])
      expect(() => reply.checkDeviceReply(submitted, answer(outcomes))).toThrow(
        reply.DeviceReplyMismatch,
      );
  });
});
