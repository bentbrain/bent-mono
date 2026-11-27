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
    // An owner reported for an earlier sign-in is ignored.
    await session.setOwner("user_stale", session.generation() - 1);
    expect(session.getState()).toEqual({ status: "signedIn", owner: null });
    await session.setOwner("user_new", session.generation());
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

  test("a refresh that finishes after sign-out cannot sign the account back in", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoked: string[] = [];
    let entered = () => undefined as void;
    const refreshing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const oauth: OAuthClient = {
      authorize: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: null }),
      refresh: async () => {
        entered();
        await gate;
        return { accessToken: "late-access", refreshToken: "late-refresh", expiresAt: null };
      },
      revoke: async (token) => void revoked.push(token),
    };
    const secrets = memorySecrets({ [keys.refresh]: "saved", [keys.owner]: "user_a" });
    const session = new Session(oauth, secrets.store);
    await session.restore();
    const pending = session.token();
    // Sign out while Clerk is answering the refresh.
    await refreshing;
    await session.signOut();
    release();
    await expect(pending).rejects.toBeInstanceOf(SessionExpired);
    expect(secrets.values.size).toBe(0);
    expect(revoked.sort()).toEqual(["late-refresh", "saved"]);
    const restored = new Session(oauth, secrets.store);
    await restored.restore();
    expect(restored.getState()).toEqual({ status: "signedOut" });
    // A token for a past sign-in is refused.
    await expect(session.token({ generation: session.generation() - 1 })).rejects.toBeInstanceOf(SessionExpired);
  });

  test("signing out refuses tokens at once, while revocation is still running", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshes = 0;
    const oauth: OAuthClient = {
      authorize: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: null }),
      refresh: async () => {
        refreshes++;
        return { accessToken: "late", refreshToken: "late-refresh", expiresAt: null };
      },
      revoke: async () => {
        await gate;
      },
    };
    const secrets = memorySecrets({ [keys.refresh]: "saved", [keys.owner]: "user_a" });
    const session = new Session(oauth, secrets.store);
    await session.restore();
    const signingOut = session.signOut();
    expect(session.getState()).toEqual({ status: "signingOut" });
    await expect(session.token()).rejects.toBeInstanceOf(SessionExpired);
    release();
    await signingOut;
    expect(refreshes).toBe(0);
    expect(secrets.values.size).toBe(0);
  });

  test("a refresh held at its Keychain write cannot touch a later sign-in's token", async () => {
    let releaseWrite = () => undefined as void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let n = 0;
    const oauth: OAuthClient = {
      authorize: async () => ({ accessToken: "b-access", refreshToken: "b-refresh", expiresAt: null }),
      refresh: async () => ({ accessToken: `a-access-${++n}`, refreshToken: `a-refresh-${n}`, expiresAt: null }),
      revoke: async () => undefined,
    };
    const memory = memorySecrets({ [keys.refresh]: "a-saved", [keys.owner]: "user_a" });
    let holdNextWrite = true;
    const secrets: SecretStore = {
      ...memory.store,
      set: async (key, value) => {
        if (holdNextWrite && value.startsWith("a-refresh")) {
          holdNextWrite = false;
          await writeGate;
        }
        return memory.store.set(key, value);
      },
    };
    const session = new Session(oauth, secrets);
    await session.restore();
    const refreshing = session.token({ fresh: true });
    // Let the refresh reach its write, then sign out and sign in as B.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const switching = (async () => {
      await session.signOut();
      await session.signIn();
    })();
    releaseWrite();
    await expect(refreshing).rejects.toBeInstanceOf(SessionExpired);
    await switching;
    expect(memory.values.get(keys.refresh)).toBe("b-refresh");
    expect(session.getState()).toEqual({ status: "signedIn", owner: null });
  });

  test("sign-out clears the Keychain before Clerk answers the revocation", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oauth: OAuthClient = {
      authorize: async () => ({ accessToken: "b-access", refreshToken: "b-refresh", expiresAt: null }),
      refresh: async () => ({ accessToken: "x", refreshToken: null, expiresAt: null }),
      revoke: async () => {
        await gate;
      },
    };
    const secrets = memorySecrets({ [keys.refresh]: "a-saved", [keys.owner]: "user_a" });
    const session = new Session(oauth, secrets.store);
    await session.restore();
    // Revocation is still waiting for Clerk when sign-out returns.
    await session.signOut();
    expect(secrets.values.size).toBe(0);
    const relaunched = new Session(oauth, secrets.store);
    await relaunched.restore();
    expect(relaunched.getState()).toEqual({ status: "signedOut" });
    // A new sign-in doesn't wait for the old revocation.
    await session.signIn();
    expect(session.getState()).toEqual({ status: "signedIn", owner: null });
    expect(secrets.values.get(keys.refresh)).toBe("b-refresh");
    release();
  });

  test("a sign-out during a sign-in's Keychain write leaves the app signed out", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => undefined as void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const oauth: OAuthClient = {
      authorize: async () => ({ accessToken: "access", refreshToken: "refresh", expiresAt: null }),
      refresh: async () => ({ accessToken: "x", refreshToken: null, expiresAt: null }),
      revoke: async () => undefined,
    };
    const memory = memorySecrets();
    const secrets: SecretStore = {
      ...memory.store,
      set: async (key, value) => {
        entered();
        await gate;
        return memory.store.set(key, value);
      },
    };
    const session = new Session(oauth, secrets);
    await session.restore();
    const signingIn = session.signIn();
    await writing;
    const signingOut = session.signOut();
    release();
    await expect(signingIn).rejects.toBeInstanceOf(SessionExpired);
    await signingOut;
    expect(session.getState()).toEqual({ status: "signedOut" });
    expect(memory.values.size).toBe(0);
  });

  test("a late refresh's revocation does not hold up the next sign-in", async () => {
    let releaseRevoke = () => undefined as void;
    const revokeGate = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    let releaseRefresh = () => undefined as void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let entered = () => undefined as void;
    const refreshing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const oauth: OAuthClient = {
      authorize: async () => ({ accessToken: "b-access", refreshToken: "b-refresh", expiresAt: null }),
      refresh: async () => {
        entered();
        await refreshGate;
        return { accessToken: "a-late", refreshToken: "a-rotated", expiresAt: null };
      },
      revoke: async () => {
        await revokeGate;
      },
    };
    const secrets = memorySecrets({ [keys.refresh]: "a-saved", [keys.owner]: "user_a" });
    const session = new Session(oauth, secrets.store);
    await session.restore();
    const late = session.token({ fresh: true });
    await refreshing;
    await session.signOut();
    releaseRefresh();
    await expect(late).rejects.toBeInstanceOf(SessionExpired);
    // Both revocations are still waiting for Clerk; signing in does not wait.
    await session.signIn();
    expect(secrets.values.get(keys.refresh)).toBe("b-refresh");
    releaseRevoke();
  });

  test("sign-out shows the sign-in screen after cleanup, and says when cleanup failed", async () => {
    const oauth: OAuthClient = {
      authorize: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: null }),
      refresh: async () => ({ accessToken: "a", refreshToken: null, expiresAt: null }),
      revoke: async () => undefined,
    };
    const secrets = memorySecrets({ [keys.refresh]: "saved", [keys.owner]: "user_a" });
    const session = new Session(oauth, secrets.store);
    await session.restore();
    const seen: string[] = [];
    await session.signOut(async () => {
      seen.push(session.getState().status);
      expect(secrets.values.size).toBe(0);
      throw new Error("disk");
    });
    expect(seen).toEqual(["signingOut"]);
    expect(session.getState()).toMatchObject({ status: "signedOut", message: expect.stringContaining("could not be removed") });
  });
});
