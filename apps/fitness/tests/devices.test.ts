import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bearer,
  configure,
  installClerkFake,
  iosClient,
  resource,
  syntheticOwner,
} from "./clerk-fake";

const fake = installClerkFake();
// No database: routes that need one report enrollment as unavailable.
const unreachable = "postgresql://test:test@127.0.0.1:9/fitness_unit";
configure(unreachable);
const environment = { ...process.env };
const auth = await import("../src/server/auth");
const devices = await import("../src/server/devices");
const { handleHealthImport } = await import("../src/server/health");
const { handleMcp } = await import("../src/server/mcp-http");

beforeEach(() => {
  fake.reset();
  Object.assign(process.env, environment);
});
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});

const deviceClaims = { kind: "fitness-ios", installationId: "x" };
function deviceKey(secret = "ak_device") {
  return fake.addKey({
    secret,
    scopes: ["fitness:health:import"],
    claims: deviceClaims,
  });
}

describe("bearer verification", () => {
  test("maps each Clerk result to one failure", async () => {
    const check = (token: string, accepts: ("api_key" | "oauth_token")[]) =>
      auth.verifyBearer(bearer(token), accepts);
    fake.addKey({ secret: "ak_live", scopes: ["fitness:read"] });
    fake.addKey({ secret: "ak_revoked", revoked: true });
    fake.addKey({ secret: "ak_expired", expired: true });
    fake.oauth.set("oat_expired", {
      userId: syntheticOwner.id,
      clientId: iosClient,
      scopes: [],
      aud: resource,
      expired: true,
    });
    expect(await check("ak_live", ["api_key"])).toMatchObject({
      ok: true,
      bearer: { tokenType: "api_key", scopes: ["fitness:read"] },
    });
    for (const token of ["ak_unknown", "ak_revoked", "ak_expired"])
      expect(await check(token, ["api_key"])).toEqual({
        ok: false,
        failure: "invalid",
      });
    expect(await check("oat_expired", ["oauth_token"])).toEqual({
      ok: false,
      failure: "rejected",
    });
    expect(await check("eyJhbGciOiJSUzI1NiJ9.e30.x", ["api_key"])).toEqual({
      ok: false,
      failure: "rejected",
    });
    fake.failure = "network";
    expect(await check("ak_live", ["api_key"])).toEqual({
      ok: false,
      failure: "unavailable",
    });
    fake.failure = "secret-key";
    expect(await check("ak_live", ["api_key"])).toEqual({
      ok: false,
      failure: "unavailable",
    });
    fake.failure = null;
    fake.throws = true;
    expect(await check("ak_live", ["api_key"])).toMatchObject({
      ok: false,
      failure: "unavailable",
    });
    expect(
      await auth.verifyBearer(
        new Request("http://127.0.0.1:3025/", {
          headers: { cookie: "__session=x" },
        }),
        ["api_key"],
      ),
    ).toEqual({ ok: false, failure: "missing" });
    delete process.env.CLERK_SECRET_KEY;
    expect(await check("ak_live", ["api_key"])).toEqual({
      ok: false,
      failure: "unconfigured",
    });
  });

  test("documents a failure for every reason it maps", () => {
    expect(auth.clerkReasonFailure).toEqual({
      "token-invalid": "invalid",
      "token-verification-failed": "rejected",
      "token-type-mismatch": "rejected",
      "secret-key-invalid": "unavailable",
      "unexpected-error": "unavailable",
    });
  });

  test("sends only the bearer, with the MCP audience", async () => {
    fake.addKey({ secret: "ak_live" });
    await auth.verifyBearer(
      bearer("ak_live", { headers: { cookie: "__session=browser" } }),
      ["api_key"],
    );
    const [sent] = fake.requests;
    expect(sent?.request.headers.get("cookie")).toBeNull();
    expect(sent?.options).toMatchObject({
      acceptsToken: ["api_key"],
      audience: resource,
    });
  });
});

describe("MCP", () => {
  test("refuses device keys and keeps other keys' access", async () => {
    deviceKey();
    fake.addKey({ secret: "ak_owner" });
    fake.addKey({
      secret: "ak_both",
      scopes: ["fitness:read", "fitness:health:import"],
    });
    await expect(
      auth.requireAgentOwner(bearer("ak_device")),
    ).rejects.toBeInstanceOf(auth.AgentScopeError);
    await expect(
      auth.requireAgentOwner(bearer("ak_both")),
    ).rejects.toBeInstanceOf(auth.AgentScopeError);
    expect(await auth.requireAgentOwner(bearer("ak_owner"))).toEqual({
      owner: syntheticOwner.id,
      access: { read: true, write: true },
    });
    const response = await handleMcp(
      bearer("ak_device", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      "insufficient_scope",
    );
  });
});

describe("Health import authentication", () => {
  const post = (token: string | null) =>
    handleHealthImport(
      token === null
        ? new Request("http://127.0.0.1:3025/api/health/import", {
            method: "POST",
            body: "{}",
          })
        : bearer(token, { method: "POST", body: "{}" }, "/api/health/import"),
    );

  test("reports a revoked key as key_invalid with the legacy challenge", async () => {
    fake.addKey({ secret: "ak_revoked", revoked: true });
    const response = await post("ak_revoked");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      error: "Send a Fitness API key as the bearer token.",
      code: "key_invalid",
    });
  });

  test("keeps the legacy 401 for a missing or mismatched bearer", async () => {
    for (const token of [null, "oat_session"]) {
      const response = await post(token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "Send a Fitness API key as the bearer token.",
        code: "unauthorized",
      });
    }
  });

  test("reports Clerk failures as retryable", async () => {
    deviceKey();
    for (const failure of ["network", "secret-key"] as const) {
      fake.failure = failure;
      const response = await post("ak_device");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
    }
    fake.failure = null;
    fake.usersDown = true;
    expect((await post("ak_device")).status).toBe(503);
  });

  test("refuses a device key whose account is no longer invited", async () => {
    deviceKey();
    process.env.FITNESS_ALLOWED_EMAILS = "someone-else@example.com";
    const response = await post("ak_device");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_invited" });
  });

  test("keeps the scope reply for keys without Fitness access", async () => {
    fake.addKey({ secret: "ak_other", scopes: ["other:scope"] });
    const response = await post("ak_other");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Approve Fitness read or write access for this connection.",
    });
  });
});

describe("Device enrollment availability", () => {
  const enroll = (token: string | null = "oat_valid") =>
    devices.handleDeviceEnroll(
      token === null
        ? new Request("http://127.0.0.1:3025/api/health/devices", {
            method: "POST",
            body: "{}",
          })
        : bearer(token, { method: "POST", body: "{}" }, "/api/health/devices"),
    );
  const prerequisites: [string, () => void][] = [
    ["the opt-in flag", () => delete process.env.FITNESS_DEVICE_ENROLLMENT],
    [
      "a flag other than enabled",
      () => {
        process.env.FITNESS_DEVICE_ENROLLMENT = "true";
      },
    ],
    [
      "client IDs",
      () => {
        process.env.FITNESS_DEVICE_CLIENT_IDS = " , ";
      },
    ],
    ["the Clerk secret key", () => delete process.env.CLERK_SECRET_KEY],
    ["the invitation list", () => delete process.env.FITNESS_ALLOWED_EMAILS],
    [
      "a valid MCP resource",
      () => {
        process.env.FITNESS_MCP_URL = "http://fitness.example.com/api/mcp";
      },
    ],
    // The database is unreachable, so the table check fails.
    ["the enrollment table", () => undefined],
  ];
  for (const [name, remove] of prerequisites)
    test(`is unavailable without ${name}`, async () => {
      remove();
      expect(await devices.deviceEnrollmentReady()).toBe(false);
      for (const response of [
        await devices.handleDeviceReady(),
        await enroll(),
        await enroll(null),
      ]) {
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toMatchObject({
          code: "enrollment_unavailable",
        });
      }
      // Unavailable enrollment answers before any bearer check.
      expect(fake.requests).toHaveLength(0);
    });
});

describe("Device disconnect", () => {
  const revoke = (token: string) =>
    devices.handleDeviceRevoke(
      bearer(token, { method: "DELETE" }, "/api/health/devices/current"),
    );

  test("revokes the verified device key, then reports it invalid", async () => {
    const key = deviceKey();
    fake.failure = "network";
    const down = await revoke("ak_device");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: "auth_unavailable" });
    expect(key.revoked).toBe(false);

    fake.failure = null;
    const done = await revoke("ak_device");
    expect(done.status).toBe(204);
    expect(done.headers.get("cache-control")).toBe("no-store");
    expect(key.revoked).toBe(true);

    // A retry after a lost reply is definitive.
    const again = await revoke("ak_device");
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: "key_invalid" });
  });

  test("keeps the key when Clerk cannot revoke it", async () => {
    const key = deviceKey();
    fake.revokeFails.add(key.id);
    const response = await revoke("ak_device");
    expect(response.status).toBe(503);
    expect(key.revoked).toBe(false);
  });

  test("revokes only iPhone sync keys", async () => {
    const owner = fake.addKey({ secret: "ak_owner" });
    const response = await revoke("ak_owner");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_device_key" });
    expect(owner.revoked).toBe(false);
  });

  test("is retryable when account services are not configured", async () => {
    deviceKey();
    delete process.env.CLERK_SECRET_KEY;
    const response = await revoke("ak_device");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
  });
});
