/**
 * Real handler replies for the iPhone sync app's wire fixtures. The test
 * sends deterministic synthetic requests with a fixed clock, writes each
 * reply to a fresh directory, and fails when the files differ from the
 * committed ones in `fixtures/wire/replies`. Set FITNESS_WIRE_FIXTURES=update
 * to rewrite the committed files.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceEnrollResponse,
  HealthImportReply,
  ApiError,
  TimezoneChangedError,
} from "@bent/fitness-contracts";
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
const { database } = await import("../src/server/db");
const devices = await import("../src/server/devices");
const { handleHealthImport } = await import("../src/server/health");
const { loadRecords, saveRecord } = await import("../src/server/store");
const { defaultSettings, settingsId } = await import("../src/domain");

const committed = new URL("./fixtures/wire/replies/", import.meta.url).pathname;
const owner = syntheticOwner.id;
const timezone = "Australia/Brisbane";
// Midday on 20 November 2026 in Brisbane.
const now = new Date("2026-11-20T02:00:00Z");
const installation = "3b0f6a52-8c1d-4e7f-9a2b-5c6d7e8f9a0b";

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
  fake.reset();
  Object.assign(process.env, environment);
});
afterAll(async () => {
  if (configured) await clean();
});

const ref = (prefix: "w" | "r", n: number) =>
  `${prefix}:${String(n).padStart(8, "0")}-1111-4222-8333-444455556666`;
const at = (date: string, time: string) => `${date}T${time}+10:00`;
function weighIn(n: number, date: string, time: string, qty: number) {
  return { ref: ref("w", n), date: at(date, time), qty };
}
function run(
  n: number,
  date: string,
  time: string,
  km: number | null,
  seconds = 1800,
) {
  return {
    ref: ref("r", n),
    name: "Running",
    start: at(date, time),
    duration: seconds,
    distance: km === null ? null : { qty: km, units: "km" },
  };
}
function deviceBody(weights: object[], workouts: object[] = [], extra = {}) {
  return {
    ...extra,
    data: {
      metrics: [{ name: "weight_body_mass", units: "kg", data: weights }],
      workouts,
    },
  };
}

async function save(data: Parameters<typeof saveRecord>[1]["data"]) {
  const result = await saveRecord(owner, {
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    revision: 0,
    data,
  });
  if (result.status !== "saved" || !result.record)
    throw new Error("Not saved.");
  return result.record;
}

test.skipIf(!configured)(
  "writes the real handler replies and matches the committed fixtures",
  async () => {
    const replies = new Map<string, { status: number; body: unknown }>();
    async function record(name: string, response: Response) {
      const text = await response.text();
      replies.set(name, {
        status: response.status,
        body: text ? JSON.parse(text) : null,
      });
    }
    const importAs = (token: string, body: unknown) =>
      handleHealthImport(
        bearer(
          token,
          { method: "POST", body: JSON.stringify(body) },
          "/api/health/import",
        ),
        { now },
      );

    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: 0,
      data: defaultSettings("2026-11-01", timezone),
    });
    await save({ kind: "weight", date: "2026-11-15", kg: 79 });
    await save({
      kind: "run",
      date: "2026-11-16",
      minutes: 30,
      distanceKm: 5,
      notes: "",
    });
    await save({
      kind: "run",
      date: "2026-11-18",
      minutes: 30,
      distanceKm: 5,
      notes: "",
    });

    // Enrollment, with the synthetic OAuth token the app gets at sign-in.
    fake.oauth.set("oat_wire_enroll", {
      userId: owner,
      clientId: iosClient,
      scopes: ["openid", "fitness:health:enroll"],
      aud: resource,
    });
    const enrollBody = JSON.stringify({
      installationId: installation,
      deviceName: "Synthetic iPhone",
    });
    const enroll = (token: string, body = enrollBody) =>
      devices.handleDeviceEnroll(
        bearer(token, { method: "POST", body }, "/api/health/devices"),
      );
    await record("ready", await devices.handleDeviceReady());
    await record("enroll", await enroll("oat_wire_enroll"));
    await record(
      "error-enrollment-token-used",
      await enroll("oat_wire_enroll"),
    );
    const [issued] = fake.keys;
    if (!issued) throw new Error("Expected the device key.");
    const device = issued.secret;

    // A run that later gives way to a closer match, sent on its own first.
    await record(
      "device-first",
      await importAs(
        device,
        deviceBody([], [run(20, "2026-11-18", "06:00:00", 5.2)]),
      ),
    );
    // Every code but removed_in_fitness and already_imported, and a displaced
    // run that this request does not send and so is not in the reply.
    const mixed = deviceBody(
      [
        weighIn(1, "2026-11-14", "06:00:00", 80.4),
        weighIn(2, "2026-11-14", "18:00:00", 81),
        weighIn(3, "2026-11-14", "06:00:00", 80.4),
        weighIn(4, "2026-11-15", "06:00:00", 80),
        weighIn(5, "2026-11-21", "06:00:00", 80),
        weighIn(6, "2026-11-13", "06:00:00", 5),
      ],
      [
        run(1, "2026-11-16", "06:00:00", 5.1),
        run(2, "2026-11-17", "06:00:00", 10),
        run(3, "2026-11-17", "06:00:00", 10),
        run(4, "2026-11-17", "18:00:00", 5, 0),
        run(5, "2026-11-22", "06:00:00", 5),
        run(6, "2026-11-18", "17:00:00", 5),
        run(7, "2026-11-19", "06:00:00", null),
      ],
    );
    await record("device-mixed", await importAs(device, mixed));
    await record("device-replay", await importAs(device, mixed));
    const run2 = (await loadRecords(owner)).find(
      (r) => r.data.kind === "run" && r.data.date === "2026-11-17",
    );
    if (!run2) throw new Error("Expected the imported run.");
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: run2.id,
      revision: run2.revision,
      data: null,
    });
    await record(
      "device-removed",
      await importAs(
        device,
        deviceBody([], [run(2, "2026-11-17", "06:00:00", 10)]),
      ),
    );

    // Errors the app branches on.
    await record(
      "error-timezone-changed",
      await importAs(
        device,
        deviceBody([weighIn(30, "2026-11-10", "06:00:00", 80)], [], {
          expectedTimezone: "Pacific/Auckland",
        }),
      ),
    );
    await record(
      "error-invalid-device-request-prefix",
      await importAs(
        device,
        deviceBody(
          [],
          [{ ...run(31, "2026-11-10", "06:00:00", 5), ref: ref("w", 31) }],
        ),
      ),
    );
    await record(
      "error-invalid-device-request-duplicate-ref",
      await importAs(
        device,
        deviceBody([
          weighIn(32, "2026-11-10", "06:00:00", 80),
          { ...weighIn(32, "2026-11-11", "06:00:00", 80) },
        ]),
      ),
    );
    const before = await loadRecords(owner);
    await record(
      "error-invalid-device-request-malformed",
      await importAs(
        device,
        deviceBody([
          weighIn(33, "2026-11-10", "06:00:00", 80),
          { ...weighIn(34, "2026-11-11", "06:00:00", 80), qty: "80" },
        ]),
      ),
    );
    expect(await loadRecords(owner)).toEqual(before);
    await record(
      "error-too-many-samples",
      await importAs(
        device,
        deviceBody(
          Array.from({ length: 2001 }, (_, i) =>
            weighIn(
              1000 + i,
              "2026-10-01",
              `06:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
              80,
            ),
          ),
        ),
      ),
    );
    await record(
      "error-payload-too-large",
      await importAs(device, { padding: "x".repeat(4_000_001) }),
    );
    fake.failure = "network";
    await record(
      "error-auth-unavailable",
      await importAs(device, deviceBody([])),
    );
    fake.failure = null;
    await record(
      "disconnect",
      await devices.handleDeviceRevoke(
        bearer(device, { method: "DELETE" }, "/api/health/devices/current"),
      ),
    );
    await record("error-key-invalid", await importAs(device, deviceBody([])));

    // Enrollment limits.
    for (const n of [1, 2, 3])
      fake.addKey({
        secret: `ak_wire_phone_${n}`,
        scopes: ["fitness:health:import"],
        claims: {
          kind: "fitness-ios",
          installationId: `3b0f6a52-8c1d-4e7f-9a2b-5c6d7e8f9a0${n}`,
        },
      });
    fake.oauth.set("oat_wire_limit", {
      userId: owner,
      clientId: iosClient,
      scopes: ["openid", "fitness:health:enroll"],
      aud: resource,
    });
    await record("error-device-limit", await enroll("oat_wire_limit"));
    process.env.FITNESS_DEVICE_ENROLLMENT = "disabled";
    await record(
      "error-enrollment-unavailable",
      await enroll("oat_wire_limit"),
    );
    process.env.FITNESS_DEVICE_ENROLLMENT =
      environment.FITNESS_DEVICE_ENROLLMENT;
    // An earlier attempt for this installation whose key creation had no
    // confirmed outcome.
    await database()`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id) VALUES(${owner},${"1".repeat(64)},${"5d1e3c2b-0a9f-4e8d-8c7b-6a5f4e3d2c1b"},${installation})`;
    fake.oauth.set("oat_wire_pending", {
      userId: owner,
      clientId: iosClient,
      scopes: ["openid", "fitness:health:enroll"],
      aud: resource,
    });
    await record("error-issuance-pending", await enroll("oat_wire_pending"));

    // Replies to other keys.
    fake.addKey({ secret: "ak_wire_owner" });
    fake.addKey({ secret: "ak_wire_write", scopes: ["fitness:write"] });
    const legacy = {
      data: {
        metrics: [
          {
            name: "weight_body_mass",
            units: "kg",
            data: [
              { date: "2026-11-09 06:00:00 +1000", qty: 80.2 },
              { date: "2099-01-01 06:00:00 +1000", qty: 80 },
            ],
          },
        ],
        workouts: [
          {
            name: "Running",
            start: "2026-11-16 06:00:00 +1000",
            duration: 1800,
            distance: { qty: 5.1, units: "km" },
          },
          { name: "Walking", start: "2026-11-16 08:00:00 +1000" },
        ],
      },
    };
    await record("legacy", await importAs("ak_wire_owner", legacy));
    await record("received", await importAs("ak_wire_write", legacy));

    // Every reply parses with the contract schema for its route.
    for (const [name, { status, body }] of replies) {
      const schema =
        name === "enroll"
          ? DeviceEnrollResponse
          : name === "error-timezone-changed"
            ? TimezoneChangedError
            : name.startsWith("error-")
              ? ApiError
              : name === "ready" || name === "disconnect"
                ? null
                : HealthImportReply;
      expect({
        name,
        ok: schema ? schema.safeParse(body).success : true,
      }).toEqual({
        name,
        ok: true,
      });
      expect({ name, error: name.startsWith("error-") }).toEqual({
        name,
        error: status >= 400,
      });
    }
    const codes = new Set(
      [...replies.values()].flatMap(({ body }) =>
        body &&
        typeof body === "object" &&
        "outcomes" in body &&
        Array.isArray(body.outcomes)
          ? body.outcomes.map((o: { code: string }) => o.code)
          : [],
      ),
    );
    expect([...codes].sort()).toEqual([
      "already_imported",
      "date_has_weighin",
      "duplicate_in_request",
      "future",
      "matched_existing",
      "new",
      "out_of_range",
      "removed_in_fitness",
    ]);

    const fresh = await mkdtemp(join(tmpdir(), "fitness-wire-"));
    try {
      for (const [name, reply] of replies)
        await writeFile(
          join(fresh, `${name}.json`),
          JSON.stringify(reply, null, 2) + "\n",
        );
      if (process.env.FITNESS_WIRE_FIXTURES === "update") {
        await rm(committed, { recursive: true, force: true });
        await mkdir(committed, { recursive: true });
        for (const name of await readdir(fresh))
          await writeFile(
            join(committed, name),
            await readFile(join(fresh, name)),
          );
      }
      const generated = (await readdir(fresh)).sort();
      const stored = (await readdir(committed).catch(() => [])).sort();
      expect(stored).toEqual(generated);
      for (const name of generated)
        expect({
          name,
          text: await readFile(join(committed, name), "utf8"),
        }).toEqual({
          name,
          text: await readFile(join(fresh, name), "utf8"),
        });
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  },
);
