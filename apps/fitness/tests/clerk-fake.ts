/**
 * A synthetic Clerk backend at the `clerkClient` boundary. It verifies
 * bearer tokens the way `@clerk/backend` reports them through
 * `authenticateRequest`, and keeps API keys and users in memory.
 */
import { mock } from "bun:test";
import { ClerkAPIResponseError } from "@clerk/shared/error";

type Claims = Record<string, unknown>;
type FakeKey = {
  id: string;
  secret: string;
  subject: string;
  name: string;
  scopes: string[];
  claims: Claims | null;
  revoked: boolean;
  expired: boolean;
  createdAt: number;
};
type OAuthToken = {
  userId: string;
  clientId: string;
  scopes: string[];
  aud?: string | string[];
  expired?: boolean;
  /** The ID Clerk verifies for the token; by default one per token string. */
  id?: string;
};
type Failure = "network" | "secret-key";

export const syntheticOwner = {
  id: "user_syntheticdeviceowner",
  email: "fitness-device+clerk_test@example.com",
};
export const iosClient = "client_synthetic_ios";
export const resource = "http://127.0.0.1:3025/api/mcp";

/** Configures Fitness for the fake, with device enrollment turned on. */
export function configure(databaseUrl: string) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    CLERK_SECRET_KEY: "sk_test_" + "synthetic",
    VITE_CLERK_PUBLISHABLE_KEY:
      "pk_test_" + Buffer.from("example.invalid$").toString("base64"),
    FITNESS_ALLOWED_EMAILS: syntheticOwner.email,
    FITNESS_MCP_URL: resource,
    FITNESS_DEVICE_ENROLLMENT: "enabled",
    FITNESS_DEVICE_CLIENT_IDS: `client_other, ${iosClient}`,
  });
}

function signedOut(reason: string, tokenType: string | null) {
  return {
    status: "signed-out",
    isAuthenticated: false,
    reason,
    tokenType,
    toAuth: () => ({ isAuthenticated: false, tokenType }),
  };
}
function signedIn(auth: Record<string, unknown>) {
  return {
    status: "signed-in",
    isAuthenticated: true,
    reason: null,
    tokenType: auth.tokenType,
    toAuth: () => ({ isAuthenticated: true, ...auth }),
  };
}

/**
 * A Backend API error reply, as the SDK throws it: with Clerk's error code
 * when Clerk answered, or none, as from a gateway.
 */
function apiError(status: number, code?: string) {
  return new ClerkAPIResponseError(`Clerk responded ${status}`, {
    data: code
      ? [{ code, message: "not found", long_message: "not found" }]
      : [],
    status,
  });
}

function createFake() {
  const fake = {
    keys: [] as FakeKey[],
    oauth: new Map<string, OAuthToken>(),
    users: new Map<string, { email: string; verified: boolean }>([
      [syntheticOwner.id, { email: syntheticOwner.email, verified: true }],
    ]),
    /** Makes verification fail as Clerk reports an outage or a bad secret key. */
    failure: null as Failure | null,
    /** Makes authenticateRequest itself throw. */
    throws: false,
    usersDown: false,
    /**
     * Key creation: fails; saves the key and then fails; or fails while
     * Clerk is still creating it, so the key appears on `appear()`.
     */
    create: "ok" as "ok" | "fail" | "lost" | "late",
    /** Holds each key creation until it settles. */
    stall: null as Promise<void> | null,
    /** Runs when a key creation starts. */
    onCreate: null as (() => void) | null,
    /** Keys Clerk is still creating. */
    inflight: [] as FakeKey[],
    /** Runs after each key list call. */
    afterList: null as (() => void) | null,
    /** Verifies bearers with this client instead, such as the real SDK. */
    backend: null as {
      authenticateRequest(
        request: Request,
        options: Record<string, unknown>,
      ): Promise<unknown>;
      apiKeys?: { verify(secret: string): Promise<unknown> };
    } | null,
    /** Key IDs whose revocation fails. */
    revokeFails: new Set<string>(),
    /** Key IDs whose lookup fails without an answer. */
    getFails: new Set<string>(),
    /** Key IDs whose lookup gets a gateway 404 without Clerk's error. */
    gatewayMissing: new Set<string>(),
    /** Key verification gets a gateway 404 without Clerk's error. */
    verifyGateway: false,
    /** Holds each key list call until it settles. */
    listStall: null as Promise<void> | null,
    pageSize: 100,
    clock: () => Date.now(),
    requests: [] as { request: Request; options: Record<string, unknown> }[],
    listCalls: 0,
    sequence: 0,
    reset() {
      fake.keys = [];
      fake.oauth.clear();
      fake.failure = null;
      fake.throws = false;
      fake.usersDown = false;
      fake.create = "ok";
      fake.revokeFails.clear();
      fake.getFails.clear();
      fake.gatewayMissing.clear();
      fake.listStall = null;
      fake.verifyGateway = false;
      fake.pageSize = 100;
      fake.requests = [];
      fake.listCalls = 0;
      fake.sequence = 0;
      fake.clock = () => Date.now();
      fake.inflight = [];
      fake.afterList = null;
      fake.stall = null;
      fake.onCreate = null;
      fake.backend = null;
    },
    /** Finishes the keys Clerk was still creating. */
    appear() {
      fake.keys.push(...fake.inflight);
      fake.inflight = [];
    },
    /** Adds a key directly, as one created earlier. */
    addKey(key: Partial<FakeKey> & { secret: string }) {
      const full: FakeKey = {
        id: `ak_id_${++fake.sequence}`,
        subject: syntheticOwner.id,
        name: "Synthetic key",
        scopes: [],
        claims: null,
        revoked: false,
        expired: false,
        createdAt: fake.clock(),
        ...key,
      };
      fake.keys.push(full);
      return full;
    },
  };

  function authenticate(token: string, accepts: string[], audience: unknown) {
    if (fake.failure === "network")
      return signedOut("unexpected-error", accepts[0] ?? null);
    if (fake.failure === "secret-key")
      return signedOut("secret-key-invalid", accepts[0] ?? null);
    const type = token.startsWith("ak_")
      ? "api_key"
      : token.startsWith("oat_")
        ? "oauth_token"
        : null;
    if (!type || !accepts.includes(type))
      return signedOut("token-type-mismatch", accepts[0] ?? null);
    if (type === "api_key") {
      const key = fake.keys.find((k) => k.secret === token);
      // The Backend API answers 404 for unknown, revoked and expired keys.
      if (!key || key.revoked || key.expired)
        return signedOut("token-invalid", "api_key");
      return signedIn({
        tokenType: "api_key",
        id: key.id,
        subject: key.subject,
        userId: key.subject.startsWith("user_") ? key.subject : null,
        orgId: key.subject.startsWith("org_") ? key.subject : null,
        name: key.name,
        scopes: key.scopes,
        claims: key.claims,
      });
    }
    // Opaque OAuth tokens: the Backend API answers 404 for unknown and
    // expired ones, and the SDK checks the audience of the token it returns.
    const oauth = fake.oauth.get(token);
    if (!oauth || oauth.expired)
      return signedOut("token-invalid", "oauth_token");
    const aud = oauth.aud === undefined ? [] : [oauth.aud].flat();
    if (!aud.includes(String(audience)))
      return signedOut("token-verification-failed", "oauth_token");
    return signedIn({
      tokenType: "oauth_token",
      id: oauth.id ?? `oat_id_${token}`,
      subject: oauth.userId,
      userId: oauth.userId,
      clientId: oauth.clientId,
      scopes: oauth.scopes,
    });
  }

  const client = {
    async authenticateRequest(
      request: Request,
      options: Record<string, unknown>,
    ) {
      fake.requests.push({ request, options });
      if (fake.backend)
        return fake.backend.authenticateRequest(request, options);
      if (fake.throws) throw new Error("Network unreachable");
      const header = request.headers.get("authorization") ?? "";
      const token = header.replace(/^Bearer\s+/i, "");
      const accepts = [options.acceptsToken].flat().map(String);
      if (!token) return signedOut("No token in header", accepts[0] ?? null);
      return authenticate(token, accepts, options.audience);
    },
    users: {
      async getUser(id: string) {
        if (fake.usersDown) throw apiError(502);
        const user = fake.users.get(id);
        if (!user) throw apiError(404);
        return {
          id,
          primaryEmailAddressId: "idn_primary",
          emailAddresses: [
            {
              id: "idn_primary",
              emailAddress: user.email,
              verification: {
                status: user.verified ? "verified" : "unverified",
              },
            },
          ],
        };
      },
    },
    apiKeys: {
      async list(params: {
        subject: string;
        includeInvalid?: boolean;
        limit?: number;
        offset?: number;
      }) {
        fake.listCalls++;
        if (fake.listStall) await fake.listStall;
        const all = fake.keys
          .filter((k) => k.subject === params.subject)
          .filter((k) => params.includeInvalid || (!k.revoked && !k.expired))
          .sort((a, b) => b.createdAt - a.createdAt);
        const limit = Math.min(params.limit ?? 10, fake.pageSize);
        const offset = params.offset ?? 0;
        fake.afterList?.();
        return {
          data: all.slice(offset, offset + limit).map((k) => ({ ...k })),
          totalCount: all.length,
        };
      },
      async create(params: {
        name: string;
        subject: string;
        scopes?: string[];
        claims?: Claims | null;
      }) {
        fake.onCreate?.();
        if (fake.stall) await fake.stall;
        if (fake.create === "fail") throw apiError(500);
        const key = fake.addKey({
          secret: `ak_secret_${fake.sequence + 1}`,
          subject: params.subject,
          name: params.name,
          scopes: params.scopes ?? [],
          claims: params.claims ?? null,
        });
        if (fake.create === "lost") throw new Error("Request timed out");
        if (fake.create === "late") {
          fake.keys.splice(fake.keys.indexOf(key), 1);
          fake.inflight.push(key);
          throw new Error("Request timed out");
        }
        return { ...key };
      },
      async verify(secret: string) {
        if (fake.backend?.apiKeys) return fake.backend.apiKeys.verify(secret);
        if (fake.verifyGateway) throw apiError(404);
        const key = fake.keys.find((k) => k.secret === secret);
        if (!key || key.revoked || key.expired)
          throw apiError(404, "resource_not_found");
        return { ...key };
      },
      async get(apiKeyId: string) {
        if (fake.getFails.has(apiKeyId)) throw apiError(502);
        if (fake.gatewayMissing.has(apiKeyId)) throw apiError(404);
        const key = fake.keys.find((k) => k.id === apiKeyId);
        if (!key) throw apiError(404, "resource_not_found");
        return { ...key };
      },
      async revoke(params: { apiKeyId: string }) {
        if (fake.revokeFails.has(params.apiKeyId)) throw apiError(500);
        const key = fake.keys.find((k) => k.id === params.apiKeyId);
        if (!key) throw apiError(404, "resource_not_found");
        key.revoked = true;
        return { ...key };
      },
    },
  };
  return { fake, client };
}

let installed: ReturnType<typeof createFake> | undefined;
/** Replaces the Clerk server module with the fake, once per test process. */
export function installClerkFake() {
  if (installed) return installed.fake;
  installed = createFake();
  const client = installed.client;
  mock.module("@clerk/tanstack-react-start/server", () => ({
    clerkClient: () => client,
    auth: async () => ({ userId: null }),
    clerkMiddleware: () => ({ options: {} }),
  }));
  return installed.fake;
}

export function bearer(token: string, init: RequestInit = {}, path = "/") {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request("http://127.0.0.1:3025" + path, { ...init, headers });
}
