import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  bearer as fakeBearer,
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
const isolated = isolatedSchema("fitness_app_api");
if (configured) configure(process.env.FITNESS_TEST_DATABASE_URL ?? "");
const environment = { ...process.env };
const { database } = await import("../src/server/db");
const api = await import("../src/server/app-api");
const { AppRecords, PhotoList, appContract } =
  await import("@bent/fitness-contracts");
const { defaultSettings, settingsId } =
  await import("@bent/fitness-contracts/domain");
const { saveRecord } = await import("../src/server/store");
const { bearerOnlyPath } = await import("../src/start");
const { setMinimumAppContractForTests } =
  await import("../src/server/contract");

/** An app request that names this build's records contract unless it names one. */
function bearer(token: string, init: RequestInit = {}, path = "/") {
  const headers = new Headers(init.headers);
  if (!headers.has("X-Fitness-Contract"))
    headers.set("X-Fitness-Contract", String(appContract));
  return fakeBearer(token, { ...init, headers }, path);
}

const owner = syntheticOwner.id;
const timezone = "Australia/Brisbane";
const appScopes = ["openid", "offline_access", "fitness:read", "fitness:write"];

function token(
  overrides: Partial<{
    userId: string;
    clientId: string;
    scopes: string[];
    aud: string;
    expired: boolean;
  }> = {},
) {
  const value = "oat_" + crypto.randomUUID();
  fake.oauth.set(value, {
    userId: owner,
    clientId: iosClient,
    scopes: appScopes,
    aud: resource,
    ...overrides,
  });
  return value;
}
const json = (value: unknown, init: RequestInit = {}) => ({
  ...init,
  method: init.method ?? "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}
const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
]).toString("base64");

async function clean() {
  const sql = database();
  await sql`DELETE FROM fitness_photos WHERE owner_id=${owner}`;
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
});
afterAll(async () => {
  if (configured) await isolated.drop();
});
beforeEach(async () => {
  fake.reset();
  Object.assign(process.env, environment);
  if (!configured) return;
  await clean();
  await saveRecord(owner, {
    operationId: crypto.randomUUID(),
    id: settingsId,
    revision: 0,
    data: defaultSettings("2026-11-01", timezone),
  });
});

test("app routes take bearer tokens only", () => {
  expect(bearerOnlyPath("/api/app")).toBe(true);
  expect(bearerOnlyPath("/api/app/records")).toBe(true);
  expect(bearerOnlyPath("/api/app/photos/abc")).toBe(true);
  expect(bearerOnlyPath("/api/apps")).toBe(false);
});

test("app routes ask builds older than the minimum contract to update", async () => {
  setMinimumAppContractForTests(3);
  try {
    for (const contract of [null, "1", "2", "not-a-number"]) {
      const init: RequestInit =
        contract === null
          ? {}
          : { headers: { "X-Fitness-Contract": contract } };
      const response = await api.handleRecordsLoad(
        fakeBearer(token(), init, "/api/app/records"),
      );
      expect(response.status).toBe(426);
      const reply = await body(response);
      // Builds that predate a code read an unknown one as a failed reply.
      expect(reply.code).toBeUndefined();
      expect(reply.error).toContain("Update bent Fitness");
    }
  } finally {
    setMinimumAppContractForTests();
  }
});

describe.skipIf(!configured)("app API", () => {
  test("loads the account's records with the current contract", async () => {
    const response = await api.handleRecordsLoad(
      bearer(
        token(),
        { headers: { "X-Fitness-Contract": "2" } },
        "/api/app/records",
      ),
    );
    expect(response.status).toBe(200);
  });

  test("loads the account's records with a read token from the app", async () => {
    const response = await api.handleRecordsLoad(
      bearer(token(), {}, "/api/app/records"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const loaded = AppRecords.parse(await response.json());
    expect(loaded.owner).toBe(owner);
    expect(loaded.records.map((r) => r.id)).toEqual([settingsId]);
    // The app offers nutrient fields once Fitness says it stores contract 2.
    expect(loaded.contract).toBe(2);
  });

  test("saves a mutation once, and reports a conflict with the current record", async () => {
    const meal = {
      kind: "meal" as const,
      date: "2026-11-20",
      name: "Oats",
      calories: 400,
      protein: 20,
    };
    const id = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const send = (revision: number, operation = operationId) =>
      api.handleRecordSave(
        bearer(
          token(),
          json({ id, revision, operationId: operation, data: meal }),
          "/api/app/records",
        ),
      );
    const first = await body(await send(0));
    expect(first.status).toBe("saved");
    // The same operation replays its stored result.
    expect(await body(await send(0))).toEqual(first);
    const stale = await body(await send(0, crypto.randomUUID()));
    expect(stale.status).toBe("conflict");
    expect((stale.current as { revision: number }).revision).toBe(1);
  });

  test("refuses saves that older app builds could not read until the minimum contract allows them", async () => {
    const settings = defaultSettings("2026-11-01", timezone);
    const save = (data: unknown, revision = 1, contract = "1") =>
      api.handleRecordSave(
        bearer(
          token(),
          {
            ...json({
              id: settingsId,
              revision,
              operationId: crypto.randomUUID(),
              data,
            }),
            headers: {
              "content-type": "application/json",
              "X-Fitness-Contract": contract,
            },
          },
          "/api/app/records",
        ),
      );
    const routine = settings.routines[0];
    if (!routine) throw new Error("Missing routine");
    const nutrients = { ...settings, nutrients: { fibre: { target: 30 } } };
    const profile = { ...settings, experience: "new" };
    // A minimum of 1 keeps every stored record readable by contract 1 builds.
    setMinimumAppContractForTests(1);
    for (const data of [
      nutrients,
      profile,
      {
        ...settings,
        routines: [
          {
            ...routine,
            exercises: [{ ...routine.exercises[0], load: "dumbbell" }],
          },
        ],
      },
    ]) {
      const refused = await save(data);
      expect(refused.status).toBe(422);
      expect((await body(refused)).error).toContain("can't read yet");
    }
    setMinimumAppContractForTests();
    try {
      const saved = await body(await save(nutrients, 1, "2"));
      expect(saved.status).toBe("saved");
      const refused = await save({ ...nutrients, experience: "new" }, 2, "2");
      expect(refused.status).toBe(422);
      expect((await body(refused)).error).toContain("can't read yet");
      setMinimumAppContractForTests(3);
      const later = await body(
        await save({ ...nutrients, experience: "new" }, 2, "3"),
      );
      expect(later.status).toBe("saved");
    } finally {
      setMinimumAppContractForTests();
    }
  });

  test("record rules reply 422 with their message, and bad bodies 400 or 413", async () => {
    const rule = await api.handleRecordSave(
      bearer(
        token(),
        json({
          id: settingsId,
          revision: 1,
          operationId: crypto.randomUUID(),
          data: null,
        }),
        "/api/app/records",
      ),
    );
    expect(rule.status).toBe(422);
    expect(await body(rule)).toEqual({
      error: "Settings must remain available.",
      code: "invalid_request",
    });
    const malformed = await api.handleRecordSave(
      bearer(token(), { method: "POST", body: "{" }, "/api/app/records"),
    );
    expect(malformed.status).toBe(400);
    const invalid = await api.handleRecordSave(
      bearer(token(), json({ id: "x" }), "/api/app/records"),
    );
    expect(invalid.status).toBe(400);
    expect((await body(invalid)).code).toBe("invalid_request");
    const large = await api.handleRecordSave(
      bearer(
        token(),
        { method: "POST", body: "x".repeat(5 * 1024 * 1024) },
        "/api/app/records",
      ),
    );
    expect(large.status).toBe(413);
  });

  test("refuses tokens that are not the app's, lack the scope or belong to someone uninvited", async () => {
    const load = (value: string | null) =>
      api.handleRecordsLoad(
        value === null
          ? new Request("http://127.0.0.1:3025/api/app/records", {
              headers: { "X-Fitness-Contract": String(appContract) },
            })
          : bearer(value, {}, "/api/app/records"),
      );
    const missing = await load(null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("invalid_token");
    expect((await load(token({ expired: true }))).status).toBe(401);
    expect(
      (await load(token({ aud: "https://other.example/api/mcp" }))).status,
    ).toBe(401);
    fake.addKey({ secret: "ak_owner", scopes: [] });
    expect((await load("ak_owner")).status).toBe(401);

    const other = await load(token({ clientId: "client_chat" }));
    expect(other.status).toBe(403);
    expect((await body(other)).code).toBe("client_not_allowed");

    const enrollOnly = await load(
      token({ scopes: ["openid", "fitness:health:enroll"] }),
    );
    expect(enrollOnly.status).toBe(403);
    expect((await body(enrollOnly)).code).toBe("insufficient_scope");
    expect(enrollOnly.headers.get("www-authenticate")).toContain(
      "insufficient_scope",
    );

    const readOnly = token({ scopes: ["fitness:read"] });
    expect((await load(readOnly)).status).toBe(200);
    const write = await api.handleRecordSave(
      bearer(readOnly, json({}), "/api/app/records"),
    );
    expect(write.status).toBe(403);
    // A save's conflict reply carries the current record, so saving needs
    // fitness:read too.
    const writeOnly = await api.handleRecordSave(
      bearer(
        token({ scopes: ["fitness:write"] }),
        json({
          id: settingsId,
          revision: 0,
          operationId: crypto.randomUUID(),
          data: defaultSettings("2026-11-01", timezone),
        }),
        "/api/app/records",
      ),
    );
    expect(writeOnly.status).toBe(403);
    expect((await body(writeOnly)).code).toBe("insufficient_scope");

    fake.users.set("user_uninvited", {
      email: "someone@example.com",
      verified: true,
    });
    const uninvited = await load(token({ userId: "user_uninvited" }));
    expect(uninvited.status).toBe(403);
    expect((await body(uninvited)).code).toBe("not_invited");

    fake.usersDown = true;
    const down = await load(token());
    expect(down.status).toBe(503);
    expect((await body(down)).code).toBe("auth_unavailable");
    fake.usersDown = false;
    fake.throws = true;
    expect((await load(token())).status).toBe(503);
    fake.throws = false;

    // A user lookup that never answers ends at the authentication deadline.
    api.setAppTimingForTests({ authMs: 200 });
    fake.usersStall = new Promise(() => undefined);
    try {
      const stalled = await load(token());
      expect(stalled.status).toBe(503);
      expect((await body(stalled)).code).toBe("auth_unavailable");
    } finally {
      api.setAppTimingForTests();
    }
  });

  test("saves a small edit to the largest settings Fitness keeps", async () => {
    const settings = defaultSettings("2026-11-01", timezone);
    const routine = settings.routines[0];
    if (!routine) throw new Error("Default settings have a routine.");
    const exercise = routine.exercises[0];
    if (!exercise) throw new Error("Default routines have exercises.");
    const big = {
      ...settings,
      dayPlans: Object.fromEntries(
        Array.from({ length: 180 }, (_, day) => [
          new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10),
          {
            type: "strength" as const,
            routine: {
              ...routine,
              name: "R".repeat(160),
              exercises: Array.from({ length: 15 }, (_, n) => ({
                ...exercise,
                id: `exercise-${n}-${"x".repeat(140)}`,
                name: "N".repeat(160),
              })),
            },
          },
        ]),
      ),
    };
    const first = await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: 1,
      data: big,
    });
    expect(first.status).toBe("saved");
    const edit = JSON.stringify({
      id: settingsId,
      revision: 2,
      operationId: crypto.randomUUID(),
      data: { ...big, calories: 2400 },
    });
    expect(edit.length).toBeGreaterThan(1024 * 1024);
    const saved = await api.handleRecordSave(
      bearer(token(), { method: "POST", body: edit }, "/api/app/records"),
    );
    expect(saved.status).toBe(200);
    expect((await body(saved)).status).toBe("saved");
  });

  test("uploads, lists, reads and removes photos", async () => {
    const id = crypto.randomUUID();
    const upload = (base64: string, photoId = id) =>
      api.handlePhotoUpload(
        bearer(
          token(),
          json({ id: photoId, name: "Rack", type: "image/png", base64 }),
          "/api/app/photos",
        ),
      );
    expect(await body(await upload(png))).toEqual({ saved: true });
    // A retried upload saves once.
    expect((await upload(png)).status).toBe(200);
    const wrong = await upload(
      Buffer.from("not an image").toString("base64"),
      crypto.randomUUID(),
    );
    expect(wrong.status).toBe(422);
    expect((await body(wrong)).error).toBe(
      "Choose a JPEG, PNG or WebP photo under 2 MB.",
    );

    const list = PhotoList.parse(
      await (
        await api.handlePhotoList(bearer(token(), {}, "/api/app/photos"))
      ).json(),
    );
    expect(list.photos).toEqual([{ id, name: "Rack", type: "image/png" }]);

    const read = await api.handlePhotoRead(
      bearer(token(), {}, `/api/app/photos/${id}`),
      id,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await read.arrayBuffer()).toString("base64")).toBe(png);
    expect(
      (await api.handlePhotoRead(bearer(token(), {}, "/"), "not-a-uuid"))
        .status,
    ).toBe(404);

    const removed = await api.handlePhotoDelete(
      bearer(token(), { method: "DELETE" }, `/api/app/photos/${id}`),
      id,
    );
    expect(await body(removed)).toEqual({ deleted: true });
    const gone = await api.handlePhotoRead(bearer(token(), {}, "/"), id);
    expect(gone.status).toBe(404);
  });

  test("exports records and photos as one download", async () => {
    await api.handlePhotoUpload(
      bearer(
        token(),
        json({
          id: crypto.randomUUID(),
          name: "Bench",
          type: "image/png",
          base64: png,
        }),
        "/",
      ),
    );
    const response = await api.handleExport(
      bearer(token(), {}, "/api/app/export"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      "fitness-export.json",
    );
    const exported = (await response.json()) as {
      format: string;
      records: { id: string }[];
      photos: { name: string; base64: string }[];
    };
    expect(exported.format).toBe("bent-fitness-v1");
    expect(exported.records.map((r) => r.id)).toEqual([settingsId]);
    expect(exported.photos).toEqual([
      expect.objectContaining({ name: "Bench", base64: png }),
    ]);
  });
});
