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
  devices.setEnrollmentBudget(1000, 1000);
  devices.forgetEnrollmentReadiness();
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
      failure: "invalid",
    });
    fake.oauth.set("oat_elsewhere", {
      userId: syntheticOwner.id,
      clientId: iosClient,
      scopes: [],
      aud: "https://other.example.com/api/mcp",
    });
    expect(await check("oat_elsewhere", ["oauth_token"])).toEqual({
      ok: false,
      failure: "invalid",
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

/** A request with the key as the whole Authorization header, without `Bearer`. */
function bare(token: string, init: RequestInit = {}, path = "/") {
  const headers = new Headers(init.headers);
  headers.set("authorization", token);
  return new Request("http://127.0.0.1:3025" + path, { ...init, headers });
}

describe("bare API keys", () => {
  test("verify as Clerk reads them, on MCP and the import", async () => {
    fake.addKey({ secret: "ak_owner" });
    fake.addKey({ secret: "ak_other", scopes: ["other:scope"] });
    expect(await auth.requireAgentOwner(bare("ak_owner"))).toEqual({
      owner: syntheticOwner.id,
      access: { read: true, write: true, targets: true, plan: true },
    });
    // Verified, then refused only for its scope, as before.
    const scoped = await handleHealthImport(
      bare("ak_other", { method: "POST", body: "{}" }, "/api/health/import"),
    );
    expect(scoped.status).toBe(403);
    expect(await scoped.json()).toEqual({
      error: "Approve Fitness read or write access for this connection.",
    });
    // Clerk passes the same token on, without the scheme.
    const [sent] = fake.requests;
    expect(sent?.request.headers.get("authorization")).toBe("Bearer ak_owner");
    // Another scheme, or a lower-case one, has no token, as in Clerk.
    for (const header of ["Basic ak_owner", "bearer ak_owner"])
      expect(await auth.verifyBearer(bare(header), ["api_key"])).toEqual({
        ok: false,
        failure: "missing",
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
      access: { read: true, write: true, targets: true, plan: true },
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

  test("needs Clerk's own not-found answer to call a key invalid", async () => {
    fake.addKey({ secret: "ak_revoked", revoked: true });
    fake.verifyGateway = true;
    const response = await post("ak_revoked");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
    const disconnect = await devices.handleDeviceRevoke(
      bearer("ak_revoked", { method: "DELETE" }, "/api/health/devices/current"),
    );
    expect(disconnect.status).toBe(503);
    expect(await disconnect.json()).toMatchObject({ code: "auth_unavailable" });
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

  test("refuses a device key that names no enrollment and revokes it", async () => {
    const key = deviceKey();
    const response = await post("ak_device");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "key_invalid" });
    expect(key.revoked).toBe(true);
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
    [
      "a publishable key Clerk accepts",
      () => {
        process.env.VITE_CLERK_PUBLISHABLE_KEY =
          "pk_test_" + Buffer.from("localhost$").toString("base64");
      },
    ],
    [
      "a well-formed publishable key",
      () => {
        process.env.VITE_CLERK_PUBLISHABLE_KEY =
          "pk_test_" + Buffer.from("example.invalid").toString("base64");
      },
    ],
    [
      "a publishable key for a Clerk instance",
      () => {
        process.env.VITE_CLERK_PUBLISHABLE_KEY =
          "pk_prod_ZXhhbXBsZS5pbnZhbGlkJA";
      },
    ],
    [
      "a well-formed secret key",
      () => {
        process.env.CLERK_SECRET_KEY = "synthetic";
      },
    ],
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

  test("is retryable when Clerk cannot verify the key", async () => {
    const key = deviceKey();
    fake.failure = "network";
    const down = await revoke("ak_device");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: "auth_unavailable" });
    expect(key.revoked).toBe(false);
  });

  test("reports a key without its enrollment as invalid and revokes it", async () => {
    const key = deviceKey();
    const response = await revoke("ak_device");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "key_invalid" });
    expect(key.revoked).toBe(true);
    // A retry after the key is revoked is definitive too.
    const again = await revoke("ak_device");
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: "key_invalid" });
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

describe("Device enrollment budget", () => {
  test("refuses attempts over the budget before any other check", async () => {
    devices.setEnrollmentBudget(10, 2);
    const enroll = () =>
      devices.handleDeviceEnroll(
        bearer("eyJhbGciOiJSUzI1NiJ9.e30.x", { method: "POST", body: "{}" }),
      );
    // The database is unreachable, so the first attempts are unavailable.
    expect((await enroll()).status).toBe(503);
    expect((await enroll()).status).toBe(503);
    const limited = await enroll();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(0);
  });

  test("limits readiness checks with the same budget", async () => {
    devices.setEnrollmentBudget(10, 1);
    expect((await devices.handleDeviceReady()).status).toBe(503);
    const limited = await devices.handleDeviceReady();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("Device enrollment readiness for a client", () => {
  const ready = (query: string, isReady = true) =>
    devices.handleDeviceReady(
      new Request(
        `https://fitness.example.com/api/health/devices/ready${query}`,
      ),
      async () => isReady,
    );

  test("answers enabled without a client, as before", async () => {
    for (const query of ["", "?ignored=1"]) {
      const response = await ready(query);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ enrollment: "enabled" });
    }
    expect(
      (await devices.handleDeviceReady(undefined, async () => true)).status,
    ).toBe(200);
  });

  test("answers enabled only for a client listed in FITNESS_DEVICE_CLIENT_IDS", async () => {
    const listed = await ready(`?clientId=${iosClient}`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ enrollment: "enabled" });
    const other = await ready("?clientId=client_stale");
    expect(other.status).toBe(403);
    expect(other.headers.get("cache-control")).toBe("no-store");
    expect(await other.json()).toMatchObject({ code: "client_not_allowed" });
  });

  test("reports unavailable enrollment before checking the client", async () => {
    for (const query of [`?clientId=${iosClient}`, "?clientId=client_stale"]) {
      const response = await ready(query, false);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "enrollment_unavailable",
      });
    }
  });

  test("refuses a malformed or repeated client once enrollment is ready", async () => {
    for (const query of [
      "?clientId=",
      "?clientId=a%20b",
      `?clientId=${"a".repeat(129)}`,
      `?clientId=${iosClient}&clientId=x`,
    ]) {
      const response = await ready(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
      // Unavailable enrollment answers first, whatever the query.
      const unavailable = await ready(query, false);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({
        code: "enrollment_unavailable",
      });
    }
  });

  test("counts client checks against the readiness budget", async () => {
    devices.setEnrollmentBudget(10, 1);
    expect((await ready(`?clientId=${iosClient}`)).status).toBe(200);
    const limited = await ready(`?clientId=${iosClient}`);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
  });
});
