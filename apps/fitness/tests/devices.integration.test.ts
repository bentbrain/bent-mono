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

const fake = installClerkFake();
const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
if (configured) configure(process.env.FITNESS_TEST_DATABASE_URL ?? "");
const environment = { ...process.env };
const { default: postgres } = await import("postgres");
const { database } = await import("../src/server/db");
const devices = await import("../src/server/devices");
const { handleHealthImport } = await import("../src/server/health");
const reply = await import("../src/server/device-reply");
const { loadRecords, saveRecord } = await import("../src/server/store");
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
  if (configured) await clean();
});
beforeEach(async () => {
  fake.reset();
  Object.assign(process.env, environment);
  devices.setEnrollmentBudget(1000, 1000);
  devices.setEnrollmentClerkTimeout(10_000);
  if (configured)
    await database()`DELETE FROM fitness_device_enrollments WHERE owner_id=${owner}`;
});

function oauthToken(
  overrides: Partial<{
    userId: string;
    clientId: string;
    scopes: string[];
    aud: string | string[] | undefined;
    expired: boolean;
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
      devices.setEnrollmentClerkTimeout(200);
      fake.stall = new Promise<void>(() => undefined);
      const begun = Date.now();
      const stalled = await enroll(oauthToken());
      expect(Date.now() - begun).toBeLessThan(2000);
      expect(stalled.status).toBe(503);
      expect(await stalled.json()).toMatchObject({ code: "issuance_failed" });
      expect(await rows()).toEqual([{ key_state: "pending", active: false }]);
      fake.stall = null;
      expect((await enroll(oauthToken())).status).toBe(201);
      expect(await rows()).toEqual([
        { key_state: "failed", active: false },
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
        { key_state: "failed", active: false },
        { key_state: "issued", active: true },
      ]);
    },
  );

  test.skipIf(!configured)(
    "limits keys created in an hour, counting the new one",
    async () => {
      for (let n = 0; n < 4; n++)
        fake.addKey({
          secret: `ak_recent_${n}`,
          revoked: true,
          scopes: ["fitness:health:import"],
          claims: { kind: "fitness-ios", installationId: installation },
          createdAt: Date.now() - 60_000 * (n + 1),
        });
      // An older key is outside the hour.
      fake.addKey({
        secret: "ak_old",
        revoked: true,
        claims: { kind: "fitness-ios", installationId: installation },
        createdAt: Date.now() - 2 * 3600_000,
      });
      expect((await enroll(oauthToken())).status).toBe(201);
      const before = fake.keys.map((k) => ({ ...k }));
      const sixth = await enroll(oauthToken());
      expect(sixth.status).toBe(429);
      expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await sixth.json()).toMatchObject({ code: "rate_limited" });
      expect(fake.keys).toEqual(before);
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
        { key_state: "failed", active: false },
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
      await database()`UPDATE fitness_device_enrollments SET created_at = now() - interval '3 days' WHERE active`;
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
          `GRANT INSERT, UPDATE, DELETE ON ${schema}.fitness_device_enrollments TO ${role}; GRANT INSERT ON ${schema}.fitness_accounts TO ${role}`,
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
      const scopeless = await post("ak_owner", legacy);
      expect(await scopeless.json()).toMatchObject({
        added: { weights: 1, runs: 0 },
        weights: [{ date: "2026-10-01", status: "added" }],
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
