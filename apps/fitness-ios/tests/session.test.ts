import { describe, expect, test } from "bun:test";
import { RefreshRejected, Session, SessionExpired } from "../src/account/session";
import type { OAuthClient, SecretStore, Tokens } from "../src/account/session";

function memorySecrets(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store: SecretStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  };
  return { store, values };
}

function fakeOAuth() {
  const calls = { authorize: 0, refresh: [] as string[], revoke: [] as string[] };
  let n = 0;
  const next = (refresh = true): Tokens => ({
    accessToken: `access-${++n}`,
    refreshToken: refresh ? `refresh-${n}` : null,
    expiresAt: 1_000_000 + 3_600_000,
  });
  const behaviour = { refresh: "ok" as "ok" | "rejected" | "offline", withRefresh: true };
  const oauth: OAuthClient = {
    async authorize() {
      calls.authorize++;
      return next(behaviour.withRefresh);
    },
    async refresh(token) {
      calls.refresh.push(token);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (behaviour.refresh === "rejected") throw new RefreshRejected("invalid_grant");
      if (behaviour.refresh === "offline") throw new TypeError("Network request failed");
      return next();
    },
    async revoke(token) {
      calls.revoke.push(token);
    },
  };
  return { oauth, calls, behaviour };
}

const keys = { refresh: "fitness.account.refresh.v1", owner: "fitness.account.owner.v1" };

describe("account session", () => {
  test("restores a saved sign-in and refreshes once for concurrent callers", async () => {
    const { oauth, calls } = fakeOAuth();
    const secrets = memorySecrets({ [keys.refresh]: "saved", [keys.owner]: "user_a" });
    const session = new Session(oauth, secrets.store, () => 1_000_000);
    await session.restore();
    expect(session.getState()).toEqual({ status: "signedIn", owner: "user_a" });
    const [a, b] = await Promise.all([session.token(), session.token()]);
    expect(a).toBe("access-1");
    expect(b).toBe("access-1");
    expect(calls.refresh).toEqual(["saved"]);
    // The rotated refresh token replaces the saved one.
    expect(secrets.values.get(keys.refresh)).toBe("refresh-1");
    // A valid token is reused; `fresh` issues a new one.
    expect(await session.token()).toBe("access-1");
    expect(await session.token({ fresh: true })).toBe("access-2");
  });

  test("refreshes shortly before expiry and after Fitness refuses a token", async () => {
    const { oauth } = fakeOAuth();
    let now = 1_000_000;
    const session = new Session(oauth, memorySecrets({ [keys.refresh]: "saved" }).store, () => now);
    await session.restore();
    expect(await session.token()).toBe("access-1");
    now = 1_000_000 + 3_600_000 - 30_000;
    expect(await session.token()).toBe("access-2");
    session.invalidate("access-2");
    expect(await session.token()).toBe("access-3");
  });

  test("signing in keeps the refresh token and needs one", async () => {
    const { oauth, behaviour } = fakeOAuth();
    const secrets = memorySecrets({ [keys.owner]: "user_old" });
    const session = new Session(oauth, secrets.store, () => 1_000_000);
    await session.restore();
    expect(session.getState()).toEqual({ status: "signedOut" });
    await session.signIn();
    expect(session.getState()).toEqual({ status: "signedIn", owner: null });
    expect(secrets.values.get(keys.refresh)).toBe("refresh-1");
    expect(secrets.values.has(keys.owner)).toBe(false);
    await session.setOwner("user_new");
    expect(session.getState()).toEqual({ status: "signedIn", owner: "user_new" });

    behaviour.withRefresh = false;
    const other = new Session(oauth, memorySecrets().store);
    await expect(other.signIn()).rejects.toThrow("refresh token");
    expect(other.getState().status).toBe("loading");
  });

  test("a refused refresh ends the session; an unreachable Clerk keeps it", async () => {
    const { oauth, behaviour } = fakeOAuth();
    const secrets = memorySecrets({ [keys.refresh]: "saved", [keys.owner]: "user_a" });
    const session = new Session(oauth, secrets.store, () => 1_000_000);
    await session.restore();

    behaviour.refresh = "offline";
    await expect(session.token()).rejects.toThrow("Network request failed");
    expect(session.getState().status).toBe("signedIn");

    behaviour.refresh = "rejected";
    await expect(session.token()).rejects.toBeInstanceOf(SessionExpired);
    expect(session.getState()).toMatchObject({ status: "signedOut" });
    expect(secrets.values.size).toBe(0);
    await expect(session.token()).rejects.toBeInstanceOf(SessionExpired);
  });

  test("signing out revokes the refresh token and forgets the account", async () => {
    const { oauth, calls } = fakeOAuth();
    const secrets = memorySecrets({ [keys.refresh]: "saved", [keys.owner]: "user_a" });
    const session = new Session(oauth, secrets.store);
    await session.restore();
    await session.signOut();
    expect(calls.revoke).toEqual(["saved"]);
    expect(secrets.values.size).toBe(0);
    expect(session.getState()).toEqual({ status: "signedOut" });
  });
});
