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
  await sql`DELETE FROM fitness_device_issuance_leases WHERE owner_id=${owner}`;
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
  if (configured) {
    await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
    await database()`DELETE FROM fitness_device_issuance_leases WHERE owner_id=${owner}`;
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
function enroll(
  token: string | null,
  body: unknown = {
    installationId: installation,
    deviceName: "Synthetic iPhone",
  },
  headers: Record<string, string> = {},
) {
  const init = {
    method: "POST",
    body: JSON.stringify(body),
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
    "refuses a second enrollment while one is issuing, without holding a connection",
    async () => {
      let release = () => undefined as void;
      fake.stall = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = () => undefined as void;
      const creating = new Promise<void>((resolve) => {
        started = resolve;
      });
      fake.onCreate = () => started();
      const first = enroll(oauthToken());
      await creating;
      // Ordinary Fitness queries still get a connection.
      expect((await loadRecords(owner)).length).toBeGreaterThan(0);
      const begun = Date.now();
      const second = await enroll(oauthToken(), {
        installationId: otherInstallation(1),
        deviceName: "Second iPhone",
      });
      expect(Date.now() - begun).toBeLessThan(2000);
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBe("10");
      expect(await second.json()).toMatchObject({ code: "issuance_pending" });
      release();
      expect((await first).status).toBe(201);
      expect(
        (
          await enroll(oauthToken(), {
            installationId: otherInstallation(1),
            deviceName: "Second iPhone",
          })
        ).status,
      ).toBe(201);
    },
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
      const fourth = await enroll(oauthToken(), {
        installationId: otherInstallation(3),
        deviceName: "Fourth iPhone",
      });
      expect(fourth.status).toBe(409);
      expect(await fourth.json()).toMatchObject({ code: "device_limit" });
      expect(fake.keys).toEqual(before);
      // Replacing an enrolled installation still fits.
      await enrolled();
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
      const sixth = await enroll(oauthToken());
      expect(sixth.status).toBe(429);
      expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(3000);
      expect(await sixth.json()).toMatchObject({ code: "rate_limited" });
      expect(fake.keys).toEqual(before);
      // Clerk's own list does not count: the late key appears, then the
      // oldest attempt leaves the hour.
      fake.appear();
      await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '2 hours', charged_at = now() - interval '2 hours' WHERE owner_id=${owner} AND created_at = (SELECT min(created_at) FROM fitness_device_enrollments WHERE owner_id=${owner})`;
      expect((await enroll(oauthToken())).status).toBe(201);
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
      // Past its two-hour bound, the ambiguous attempt stops counting.
      await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '121 minutes' WHERE owner_id=${owner} AND key_state='ambiguous'`;
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
    "skips a stalled key list without using the time kept for the create",
    async () => {
      const current = await enrolled();
      fake.listStall = new Promise<void>(() => undefined);
      // Cleanup may run until the deadline less the create's reserve, and
      // stalls that long, so too little time is left to create a key.
      devices.setEnrollmentTiming({
        deadlineMs: 1000,
        cleanupMs: 5000,
        createReserveMs: 600,
      });
      const token = oauthToken();
      const before = await rows();
      const refused = await enroll(token);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: "issuance_pending" });
      expect(await rows()).toEqual(before);
      expect((await importWith(current)).status).toBe(200);
      // With its own budget, a stalled list is skipped and the enrollment
      // goes on with the same token.
      devices.setEnrollmentTiming({
        deadlineMs: 5000,
        cleanupMs: 300,
        createReserveMs: 600,
      });
      const replaced = await enroll(token);
      expect(replaced.status).toBe(201);
      expect((await importWith(current)).status).toBe(401);
    },
  );

  test.skipIf(!configured)(
    "uses no token when recording waits on an import past the lease or deadline",
    async () => {
      let previous = await enrolled();
      const importer = postgres(isolated.url, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      try {
        for (const timing of [
          // The lease runs out while the insert waits.
          { leaseSeconds: 1 },
          // The deadline runs out while the insert waits.
          { deadlineMs: 1200, createReserveMs: 100 },
          // The time kept for the create starts while the insert waits.
          { deadlineMs: 3000, createReserveMs: 2000 },
        ]) {
          devices.setEnrollmentTiming(timing);
          const token = oauthToken();
          const before = await rows();
          let response: Response | undefined;
          await importer.begin(async (tx) => {
            // An import holds the account row, which recording the attempt
            // waits on through its foreign key.
            await tx`SELECT 1 FROM fitness_accounts WHERE owner_id=${owner} FOR UPDATE`;
            const pending = enroll(token);
            await Bun.sleep(1500);
            await tx`SELECT 1`;
            void pending.then((r) => {
              response = r;
            });
          });
          for (let n = 0; n < 50 && !response; n++) await Bun.sleep(50);
          if (!response) throw new Error("Expected the enrollment to finish.");
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({
            code: "issuance_pending",
          });
          expect(await rows()).toEqual(before);
          expect((await importWith(previous)).status).toBe(200);
          // The token was not used, so it enrolls once nothing waits.
          devices.setEnrollmentTiming();
          const enrolledNow = await enroll(token);
          expect(enrolledNow.status).toBe(201);
          previous = (await enrolledNow.json()).secret;
        }
      } finally {
        devices.setEnrollmentTiming();
        await importer.end();
      }
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
      const owner = connect();
      const limited = connect(role);
      try {
        expect(await devices.deviceEnrollmentReady(owner)).toBe(false);
        await owner.unsafe(
          await Bun.file(new URL("../schema.sql", import.meta.url)).text(),
        );
        expect(await devices.deviceEnrollmentReady(owner)).toBe(true);
        await owner.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
        );
        expect(await devices.deviceEnrollmentReady(limited)).toBe(false);
        await owner.unsafe(
          `GRANT INSERT, UPDATE, DELETE ON ${schema}.fitness_device_enrollments, ${schema}.fitness_device_issuance_leases TO ${role}; GRANT INSERT, UPDATE ON ${schema}.fitness_device_attempt_windows TO ${role}; GRANT INSERT ON ${schema}.fitness_accounts TO ${role}`,
        );
        // Pruning old attempt windows needs DELETE too.
        expect(await devices.deviceEnrollmentReady(limited)).toBe(false);
        await owner.unsafe(
          `GRANT DELETE ON ${schema}.fitness_device_attempt_windows TO ${role}`,
        );
        expect(await devices.deviceEnrollmentReady(limited)).toBe(true);
        await owner`DROP TABLE fitness_device_enrollments`;
        expect(await devices.deviceEnrollmentReady(owner)).toBe(false);
      } finally {
        await limited.end();
        await owner.end();
        await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await sql.unsafe(`DROP OWNED BY ${role}`);
        await sql.unsafe(`DROP ROLE ${role}`);
      }
      expect(await devices.deviceEnrollmentReady()).toBe(true);
    },
  );
});

describe("device issuance lease and attempt windows", () => {
  const url = isolated.url;
  const client = () =>
    postgres(url, { max: 2, prepare: false, onnotice: () => undefined });

  test.skipIf(!configured)(
    "lets one of two independent clients hold an owner's lease",
    async () => {
      const [a, b] = [client(), client()];
      const holders = [crypto.randomUUID(), crypto.randomUUID()] as const;
      try {
        const results = await Promise.all([
          store.acquireDeviceLease(a, owner, holders[0], 90),
          store.acquireDeviceLease(b, owner, holders[1], 90),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results[0] ? 0 : 1;
        const loserClient = winner === 0 ? b : a;
        const loser = holders[winner === 0 ? 1 : 0];
        expect(
          await store.acquireDeviceLease(loserClient, owner, loser, 90),
        ).toBe(false);
        // The loser cannot release the winner's lease.
        await store.releaseDeviceLease(loserClient, owner, loser);
        expect(
          await store.acquireDeviceLease(loserClient, owner, loser, 90),
        ).toBe(false);
        await store.releaseDeviceLease(
          winner === 0 ? a : b,
          owner,
          holders[winner],
        );
        expect(
          await store.acquireDeviceLease(loserClient, owner, loser, 90),
        ).toBe(true);
        await store.releaseDeviceLease(loserClient, owner, loser);
      } finally {
        await Promise.all([a.end(), b.end()]);
      }
    },
  );

  test.skipIf(!configured)(
    "releases the lease when the work fails",
    async () => {
      await expect(
        store.withDeviceLease(owner, 90, async () => {
          throw new Error("Synthetic failure");
        }),
      ).rejects.toThrow("Synthetic failure");
      expect(await store.withDeviceLease(owner, 90, async () => "free")).toBe(
        "free",
      );
    },
  );

  test.skipIf(!configured)("takes over an expired lease", async () => {
    await database()`INSERT INTO fitness_device_issuance_leases(owner_id, holder, expires_at) VALUES(${owner}, ${crypto.randomUUID()}, now() - interval '1 second')`;
    expect((await enroll(oauthToken())).status).toBe(201);
    await database()`INSERT INTO fitness_device_issuance_leases(owner_id, holder, expires_at) VALUES(${owner}, ${crypto.randomUUID()}, now() + interval '90 seconds')`;
    const busy = await enroll(oauthToken());
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ code: "issuance_pending" });
  });

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
    "answers busy at once while the lease holder waits behind an import",
    async () => {
      await database()`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      const current = crypto.randomUUID();
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,key_state,key_id,active,charged_at) VALUES(${owner},${"f".repeat(64)},${current},${installation},'issued','ak_id_current',true,now())`;
      const importer = client();
      const other = client();
      try {
        // A live lease, then one that expires while its holder still waits.
        for (const seconds of [90, 0.3]) {
          const holder = crypto.randomUUID();
          expect(
            await store.acquireDeviceLease(database(), owner, holder, seconds),
          ).toBe(true);
          let waiting: Promise<void> | undefined;
          await importer.begin(async (tx) => {
            await tx`SELECT 1 FROM fitness_device_enrollments WHERE attempt_id=${current} FOR SHARE`;
            waiting = store.deactivateInstallation(
              database(),
              { owner, holder },
              installation,
            );
            waiting.catch(() => undefined);
            await Bun.sleep(500);
            const begun = performance.now();
            expect(
              await store.acquireDeviceLease(
                other,
                owner,
                crypto.randomUUID(),
                90,
              ),
            ).toBe(false);
            expect(performance.now() - begun).toBeLessThan(400);
          });
          await waiting?.catch(() => undefined);
          await store.releaseDeviceLease(database(), owner, holder);
          await database()`UPDATE fitness_device_enrollments SET active=true WHERE attempt_id=${current}`;
        }
      } finally {
        await Promise.all([importer.end(), other.end()]);
      }
    },
  );

  test.skipIf(!configured)(
    "fails a write that waited on the lease past its expiry",
    async () => {
      const holder = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      await database()`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      expect(
        await store.acquireDeviceLease(database(), owner, holder, 90),
      ).toBe(true);
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id) VALUES(${owner},${"b".repeat(64)},${attemptId},${installation})`;
      const locker = client();
      try {
        let activation: Promise<boolean> | undefined;
        await locker.begin(async (tx) => {
          await tx`SELECT 1 FROM fitness_device_issuance_leases WHERE owner_id=${owner} FOR UPDATE`;
          // The activation starts while the lease is valid, then waits.
          activation = store.issueEnrollment(
            database(),
            { owner, holder },
            attemptId,
            "ak_id_waited",
          );
          activation.catch(() => undefined);
          await Bun.sleep(200);
          await tx`UPDATE fitness_device_issuance_leases SET expires_at = clock_timestamp() + interval '300 milliseconds' WHERE owner_id=${owner}`;
          await Bun.sleep(600);
        });
        await expect(activation).rejects.toBeInstanceOf(store.DeviceLeaseLost);
        expect(await rows()).toEqual([{ key_state: "pending", active: false }]);
      } finally {
        await locker.end();
        await store.releaseDeviceLease(database(), owner, holder);
      }
    },
  );

  test.skipIf(!configured)(
    "rolls back when two waits together pass the deadline",
    async () => {
      await database()`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      const current = crypto.randomUUID();
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,key_state,key_id,active,charged_at) VALUES(${owner},${"9".repeat(64)},${current},${installation},'issued','ak_id_current',true,now())`;
      const holder = crypto.randomUUID();
      expect(
        await store.acquireDeviceLease(database(), owner, holder, 90),
      ).toBe(true);
      const [first, second] = [client(), client()];
      try {
        let releaseFirst = () => undefined as void;
        let releaseSecond = () => undefined as void;
        const held = [
          // One transaction holds the account row for 600 ms...
          first.begin(async (tx) => {
            await tx`SELECT 1 FROM fitness_accounts WHERE owner_id=${owner} FOR UPDATE`;
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
              setTimeout(resolve, 600);
            });
          }),
          // ...and another the installation's current row for 1300 ms.
          second.begin(async (tx) => {
            await tx`SELECT 1 FROM fitness_device_enrollments WHERE attempt_id=${current} FOR SHARE`;
            await new Promise<void>((resolve) => {
              releaseSecond = resolve;
              setTimeout(resolve, 1300);
            });
          }),
        ];
        await Bun.sleep(50);
        const digest = "8".repeat(64);
        // Each wait alone fits in one second; together they do not.
        const begun = performance.now();
        await expect(
          store.recordEnrollment(
            database(),
            { owner, holder, deadline: performance.now() + 1000 },
            {
              tokenId: "oat_id_two_waits",
              digest,
              attemptId: crypto.randomUUID(),
              installationId: installation,
            },
          ),
        ).rejects.toBeInstanceOf(store.DeviceLeaseLost);
        expect(performance.now() - begun).toBeLessThan(1200);
        releaseFirst();
        releaseSecond();
        await Promise.all(held);
        const used =
          await database()`SELECT 1 FROM fitness_device_enrollments WHERE token_digest=${digest}`;
        expect(used).toHaveLength(0);
        const [row] =
          await database()`SELECT active FROM fitness_device_enrollments WHERE attempt_id=${current}`;
        expect(row?.active).toBe(true);
      } finally {
        await Promise.all([first.end(), second.end()]);
        await store.releaseDeviceLease(database(), owner, holder);
      }
    },
  );

  test.skipIf(!configured)(
    "fails an activation that waited on its enrollment row past the lease's expiry",
    async () => {
      const holder = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      await database()`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      // A lease that expires while the activation waits.
      expect(
        await store.acquireDeviceLease(database(), owner, holder, 0.4),
      ).toBe(true);
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id) VALUES(${owner},${"c".repeat(64)},${attemptId},${installation})`;
      const locker = client();
      try {
        let activation: Promise<boolean> | undefined;
        await locker.begin(async (tx) => {
          // Another transaction, such as an import, holds the row.
          await tx`SELECT 1 FROM fitness_device_enrollments WHERE attempt_id=${attemptId} FOR UPDATE`;
          activation = store.issueEnrollment(
            database(),
            { owner, holder },
            attemptId,
            "ak_id_waited_row",
          );
          activation.catch(() => undefined);
          await Bun.sleep(800);
        });
        await expect(activation).rejects.toBeInstanceOf(store.DeviceLeaseLost);
        expect(await rows()).toEqual([{ key_state: "pending", active: false }]);
      } finally {
        await locker.end();
        await store.releaseDeviceLease(database(), owner, holder);
      }
    },
  );

  test.skipIf(!configured)(
    "never leaves two active keys or a wrongly active one under contention",
    async () => {
      await database()`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      const current = crypto.randomUUID();
      await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id,key_state,key_id,active,charged_at) VALUES(${owner},${"d".repeat(64)},${current},${installation},'issued','ak_id_current',true,now())`;
      const active = async () =>
        (
          await database()`SELECT attempt_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND active`
        ).map((r) => r.attempt_id);
      // A replacement whose deactivation waits behind an import's hold on the
      // current row, while its lease runs out, changes nothing.
      const slow = crypto.randomUUID();
      expect(await store.acquireDeviceLease(database(), owner, slow, 0.4)).toBe(
        true,
      );
      const importer = client();
      try {
        let replacing: Promise<void> | undefined;
        await importer.begin(async (tx) => {
          await tx`SELECT 1 FROM fitness_device_enrollments WHERE attempt_id=${current} FOR SHARE`;
          replacing = store.deactivateInstallation(
            database(),
            { owner, holder: slow },
            installation,
          );
          replacing.catch(() => undefined);
          await Bun.sleep(800);
        });
        await expect(replacing).rejects.toBeInstanceOf(store.DeviceLeaseLost);
        expect(await active()).toEqual([current]);
      } finally {
        await importer.end();
        await store.releaseDeviceLease(database(), owner, slow);
      }
      // A second activation for the installation while its key is still
      // active fails, so the installation never has two active keys.
      const holder = crypto.randomUUID();
      expect(
        await store.acquireDeviceLease(database(), owner, holder, 90),
      ).toBe(true);
      try {
        const next = crypto.randomUUID();
        await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id) VALUES(${owner},${"e".repeat(64)},${next},${installation})`;
        await expect(
          store.issueEnrollment(
            database(),
            { owner, holder },
            next,
            "ak_id_second",
          ),
        ).rejects.toThrow();
        expect(await active()).toEqual([current]);
        // With the current key deactivated first, the next one activates.
        await store.deactivateInstallation(
          database(),
          { owner, holder },
          installation,
        );
        expect(
          await store.issueEnrollment(
            database(),
            { owner, holder },
            next,
            "ak_id_second",
          ),
        ).toBe(true);
        expect(await active()).toEqual([next]);
      } finally {
        await store.releaseDeviceLease(database(), owner, holder);
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

  test.skipIf(!configured)(
    "stops writing once another request takes over the lease",
    async () => {
      let release = () => undefined as void;
      fake.stall = new Promise<void>((resolve) => {
        release = resolve;
      });
      const creating = new Promise<void>((resolve) => {
        fake.onCreate = resolve;
      });
      const first = enroll(oauthToken());
      await creating;
      // The first request's lease expires and a second client takes it.
      const other = client();
      const holder = crypto.randomUUID();
      try {
        await other`UPDATE fitness_device_issuance_leases SET expires_at = now() - interval '1 second' WHERE owner_id=${owner}`;
        expect(await store.acquireDeviceLease(other, owner, holder, 90)).toBe(
          true,
        );
        release();
        const response = await first;
        expect(response.status).not.toBe(201);
        expect(await response.json()).toMatchObject({
          code: "issuance_failed",
        });
        // Its key was created, then revoked, and never became active.
        const [created] = fake.keys.filter(
          (k) => k.claims?.installationId === installation,
        );
        expect(created?.revoked).toBe(true);
        expect(await rows()).toEqual([{ key_state: "pending", active: false }]);
        // The second holder's lease is intact.
        const [lease] =
          await other`SELECT holder FROM fitness_device_issuance_leases WHERE owner_id=${owner}`;
        expect(lease?.holder).toBe(holder);
        // Without the lease, a fenced write changes nothing.
        await expect(
          store.deactivateInstallation(
            database(),
            { owner, holder: crypto.randomUUID() },
            installation,
          ),
        ).rejects.toBeInstanceOf(store.DeviceLeaseLost);
      } finally {
        await store.releaseDeviceLease(other, owner, holder);
        await other.end();
      }
    },
  );
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

  test.skipIf(!configured)(
    "finishes both a reconnect and an import already holding the account",
    async () => {
      for (let round = 0; round < 5; round++) {
        // A fresh account each round, so the hourly limit stays out of it.
        await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
        fake.keys = [];
        const secret = await enrolled();
        const paused = importInsideItsLock(secret);
        await paused.waiting;
        // The reconnect starts while the import holds the account row.
        const reconnect = enroll(oauthToken());
        await Bun.sleep(100 + round * 50);
        paused.release();
        const [imported, reconnected] = await Promise.all([
          paused.response,
          reconnect,
        ]);
        // The import came first and committed, or it found its key replaced.
        expect([200, 401]).toContain(imported.status);
        if (imported.status === 401)
          expect(await imported.json()).toMatchObject({ code: "key_invalid" });
        expect(reconnected.status).toBe(201);
        expect(activeFor(installation)).toHaveLength(1);
      }
    },
  );

  test.skipIf(!configured)(
    "finishes both when the import reaches the account after the reconnect",
    async () => {
      for (let round = 0; round < 5; round++) {
        // A fresh account each round, so the hourly limit stays out of it.
        await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
        fake.keys = [];
        const secret = await enrolled();
        const reconnect = enroll(oauthToken());
        await Bun.sleep(round * 5);
        const imported = await importWith(secret);
        const reconnected = await reconnect;
        expect([200, 401]).toContain(imported.status);
        expect(reconnected.status).toBe(201);
      }
    },
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
