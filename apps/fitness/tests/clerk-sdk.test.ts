/**
 * Bearer verification through the pinned `@clerk/backend`, with only its
 * HTTP transport stubbed. OAuth access tokens here are real signed JWTs.
 */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bearer,
  configure,
  installClerkFake,
  iosClient,
  resource,
  syntheticOwner,
} from "./clerk-fake";

const fake = installClerkFake();
configure("postgresql://test:test@127.0.0.1:9/fitness_unit");
const environment = { ...process.env };
const auth = await import("../src/server/auth");
const devices = await import("../src/server/devices");
const store = await import("../src/server/store");

// The backend version @clerk/tanstack-react-start resolves, not the root one.
const start = Bun.resolveSync(
  "@clerk/tanstack-react-start/server",
  import.meta.dir,
);
const backendEntry = Bun.resolveSync("@clerk/backend", dirname(start));
const backendRoot = backendEntry.slice(
  0,
  backendEntry.lastIndexOf("/@clerk/backend/") + "/@clerk/backend".length,
);
const backendVersion = JSON.parse(
  readFileSync(join(backendRoot, "package.json"), "utf8"),
).version;
const { createClerkClient } = await import(backendEntry);

type Jwk = JsonWebKey & { kid: string };
async function signingKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  } as Jwk;
  return { kid, jwk, privateKey: pair.privateKey };
}
const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
async function accessToken(
  key: Awaited<ReturnType<typeof signingKey>>,
  claims: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: "RS256", typ: "at+jwt", kid: key.kid })}.${encode(
    {
      iss: "https://example.invalid",
      sub: syntheticOwner.id,
      client_id: iosClient,
      scp: ["openid", "fitness:health:enroll"],
      aud: resource,
      iat: now - 60,
      exp: now + 600,
      jti: "oat_synthetic",
      ...claims,
    },
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${Buffer.from(signature).toString("base64url")}`;
}

const served = await signingKey("synthetic-served");
const unserved = await signingKey("synthetic-unserved");
let jwksUp = true;
const realFetch = globalThis.fetch;
const jwksRequests: string[] = [];
globalThis.fetch = (async (input: Request | string | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.endsWith("/v1/jwks"))
    throw new Error(`Unexpected request to ${url}`);
  jwksRequests.push(url);
  return jwksUp
    ? Response.json({ keys: [served.jwk] })
    : Response.json({ errors: [] }, { status: 503 });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  fake.reset();
  Object.assign(process.env, environment);
  fake.backend = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
  });
  jwksUp = true;
});

// Readiness passes without a database; verification fails before any write.
let tableCheck: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  tableCheck?.mockRestore();
  tableCheck = undefined;
});
function enroll(token: string) {
  tableCheck ??= spyOn(store, "enrollmentTableExists").mockResolvedValue(true);
  return devices.handleDeviceEnroll(
    bearer(
      token,
      { method: "POST", body: "{}", headers: { cookie: "__session=x" } },
      "/api/health/devices",
    ),
  );
}

test("uses the backend version the app resolves", () => {
  expect(backendVersion).toMatch(/^3\.29\./);
});

test("reports a signing-key outage as retryable", async () => {
  jwksUp = false;
  const token = await accessToken(unserved);
  expect(await auth.verifyBearer(bearer(token), ["oauth_token"])).toEqual({
    ok: false,
    failure: "unavailable",
  });
  const response = await enroll(token);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
  expect(jwksRequests.length).toBeGreaterThan(0);
}, 30_000);

test("verifies a token and reads its client and scopes", async () => {
  const token = await accessToken(served);
  expect(await auth.verifyBearer(bearer(token), ["oauth_token"])).toMatchObject(
    {
      ok: true,
      bearer: {
        tokenType: "oauth_token",
        userId: syntheticOwner.id,
        clientId: iosClient,
        scopes: ["openid", "fitness:health:enroll"],
      },
    },
  );
});

test("refuses expired tokens and other audiences conclusively", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { iat: now - 7200, exp: now - 3600 },
    { aud: "https://other.example.com/api/mcp" },
    { aud: undefined },
  ]) {
    const token = await accessToken(served, claims);
    expect(await auth.verifyBearer(bearer(token), ["oauth_token"])).toEqual({
      ok: false,
      failure: "invalid",
    });
    const response = await enroll(token);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  }
});

test("treats a bad signature as retryable", async () => {
  const token = await accessToken(served);
  const [header, payload] = token.split(".");
  const forged = `${header}.${payload}.${Buffer.from("forged").toString("base64url")}`;
  expect(await auth.verifyBearer(bearer(forged), ["oauth_token"])).toEqual({
    ok: false,
    failure: "unavailable",
  });
});
