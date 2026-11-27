/**
 * The server half of the iPhone app's contract round trip. The Swift
 * encoder writes requests to `$FITNESS_IOS_WIRE_DIR/requests`; this test
 * sends each one to the real import handler as a device key, then records
 * real enrollment, import and disconnect replies for the branches that have
 * no committed fixture. Every reply goes to `$FITNESS_IOS_WIRE_DIR/replies`
 * as `{status, headers, body}` for the Swift decoder to check.
 *
 * Clerk is replaced by the synthetic fake at its client boundary only, so
 * body limits, auth mapping and reply selection all run for real against
 * Postgres. Run it with `apps/fitness-ios/scripts/roundtrip.mjs`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeviceReply } from "@bent/fitness-contracts";
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
const wire = process.env.FITNESS_IOS_WIRE_DIR ?? "";
const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL && wire);
if (wire && !process.env.FITNESS_TEST_DATABASE_URL)
  throw new Error("FITNESS_TEST_DATABASE_URL is required for the round trip.");
const isolated = isolatedSchema("fitness_ios_wire");
if (configured) configure(process.env.FITNESS_TEST_DATABASE_URL ?? "");
const devices = await import("../src/server/devices");
const { handleHealthImport } = await import("../src/server/health");
const { saveRecord, setEnrollmentWait } = await import("../src/server/store");
const { default: postgres } = await import("postgres");
const { defaultSettings, settingsId } =
  await import("@bent/fitness-contracts/domain");

/** The clock the Swift side uses: midday on 20 November 2026 in Brisbane. */
const now = new Date("2026-11-20T02:00:00Z");
const installation = "3b0f6a52-8c1d-4e7f-9a2b-5c6d7e8f9a0b";

beforeAll(async () => {
  if (!configured) return;
  await isolated.create();
  await isolated
    .pool()
    .unsafe(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
  fake.reset();
  devices.setEnrollmentBudget(1000, 1000);
  devices.setSharedEnrollmentLimit(100_000);
  devices.setEnrollmentTiming();
});
afterAll(async () => {
  if (configured) await isolated.drop();
});

async function record(name: string, response: Response) {
  const text = await response.text();
  const retryAfter = response.headers.get("retry-after");
  const reply = {
    status: response.status,
    headers: retryAfter ? { "Retry-After": retryAfter } : {},
    body: text ? JSON.parse(text) : null,
  };
  await writeFile(
    join(wire, "replies", `${name}.json`),
    JSON.stringify(reply, null, 2) + "\n",
  );
  return reply;
}

function oauth(token: string) {
  fake.oauth.set(token, {
    userId: syntheticOwner.id,
    clientId: iosClient,
    scopes: ["openid", "fitness:health:enroll"],
    aud: resource,
  });
}

// Each attempt counts one higher, as the app counts them.
let sequence = 0;
const enroll = (token: string, enrollmentSequence = ++sequence) =>
  devices.handleDeviceEnroll(
    bearer(
      token,
      {
        method: "POST",
        body: JSON.stringify({
          installationId: installation,
          deviceName: "Synthetic iPhone",
          enrollmentSequence,
        }),
      },
      "/api/health/devices",
    ),
  );

function importAs(
  key: string,
  body: unknown,
  form: "bearer" | "bare" = "bearer",
) {
  const request = new Request("http://127.0.0.1:3025/api/health/import", {
    method: "POST",
    headers: { authorization: form === "bearer" ? `Bearer ${key}` : key },
    body: JSON.stringify(body),
  });
  return handleHealthImport(request, { now });
}

const revoke = (key: string) =>
  devices.handleDeviceRevoke(
    bearer(key, { method: "DELETE" }, "/api/health/devices/current"),
  );

test.skipIf(!configured)(
  "answers the Swift requests and the reply branches the app handles",
  async () => {
    await mkdir(join(wire, "replies"), { recursive: true });
    await saveRecord(syntheticOwner.id, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: 0,
      data: defaultSettings("2026-11-01", "Australia/Brisbane"),
    });

    // Enrollment through the real handler, as the app's first sign-in.
    oauth("oat_roundtrip_enroll");
    const enrolled = await record(
      "enroll",
      await enroll("oat_roundtrip_enroll"),
    );
    expect(enrolled.status).toBe(201);
    const key = (enrolled.body as { secret: string }).secret;

    // Each Swift-encoded request, in the order the cases were written.
    const order = [
      "mixed",
      "replay",
      "backfill",
      "timezone-changed",
      "too-many",
    ];
    const files = (await readdir(join(wire, "requests"))).sort();
    expect(files).toEqual(order.map((name) => `${name}.json`).sort());
    for (const name of order) {
      const request = JSON.parse(
        await readFile(join(wire, "requests", `${name}.json`), "utf8"),
      ) as {
        body: unknown;
        submitted: { ref: string; type: string }[];
        expected: Record<string, string>;
      };
      const reply = await record(name, await importAs(key, request.body));
      if (Object.keys(request.expected).length) {
        expect({ name, status: reply.status }).toEqual({ name, status: 200 });
        const parsed = DeviceReply.parse(reply.body);
        const codes: Record<string, string> = Object.fromEntries(
          parsed.outcomes.map((o) => [o.ref, o.code]),
        );
        expect(codes).toEqual(request.expected);
      }
    }

    // Both Authorization forms for a device key, with weigh-ins and runs.
    const backfill = JSON.parse(
      await readFile(join(wire, "requests", "backfill.json"), "utf8"),
    ) as { body: unknown };
    expect(
      (await record("import-bearer", await importAs(key, backfill.body)))
        .status,
    ).toBe(200);
    expect(
      (await record("import-bare", await importAs(key, backfill.body, "bare")))
        .status,
    ).toBe(200);

    // Clerk outages on every route.
    fake.failure = "network";
    oauth("oat_roundtrip_outage");
    expect(
      (
        await record(
          "enroll-auth-unavailable",
          await enroll("oat_roundtrip_outage"),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await record(
          "import-auth-unavailable",
          await importAs(key, backfill.body),
        )
      ).status,
    ).toBe(503);
    expect(
      (await record("revoke-auth-unavailable", await revoke(key))).status,
    ).toBe(503);
    fake.failure = null;

    // Recording waits on the account row another connection holds, past
    // its lock wait, so the token stays unused.
    oauth("oat_roundtrip_busy");
    setEnrollmentWait(300);
    const holder = postgres(isolated.url, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    let release = () => undefined as void;
    let taken = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const holding = holder.begin(async (tx) => {
      await tx`SELECT owner_id FROM fitness_accounts WHERE owner_id=${syntheticOwner.id} FOR UPDATE`;
      taken();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    try {
      await held;
      const pending = await record(
        "enroll-issuance-pending",
        await enroll("oat_roundtrip_busy"),
      );
      expect(pending.status).toBe(503);
      expect(pending.headers).toEqual({ "Retry-After": "10" });
    } finally {
      release();
      await holding;
      await holder.end();
      setEnrollmentWait();
    }

    // The app connects again with a higher sequence and gets a new key.
    oauth("oat_roundtrip_again");
    const replaced = await enroll("oat_roundtrip_again");
    expect(replaced.status).toBe(201);
    const current = ((await replaced.json()) as { secret: string }).secret;

    // An attempt from a sequence the installation already passed.
    oauth("oat_roundtrip_stale");
    const stale = await record(
      "enroll-stale",
      await enroll("oat_roundtrip_stale", 1),
    );
    expect(stale.status).toBe(409);

    // Clerk fails to create the key after the token is used.
    fake.create = "fail";
    oauth("oat_roundtrip_failed");
    expect(
      (
        await record(
          "enroll-issuance-failed",
          await enroll("oat_roundtrip_failed"),
        )
      ).status,
    ).toBe(503);
    fake.create = "ok";

    // Too many attempts reach this server.
    devices.setEnrollmentBudget(1, 0);
    oauth("oat_roundtrip_limited");
    const limited = await record(
      "enroll-rate-limited",
      await enroll("oat_roundtrip_limited"),
    );
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["Retry-After"])).toBeGreaterThan(0);
    devices.setEnrollmentBudget(1000, 1000);

    // Disconnect, a lost 204, and the retry that follows it.
    expect((await record("revoke", await revoke(current))).status).toBe(204);
    expect((await record("revoke-retry", await revoke(current))).status).toBe(
      401,
    );
    expect(
      (
        await record(
          "import-after-revoke",
          await importAs(current, backfill.body),
        )
      ).status,
    ).toBe(401);
  },
);
