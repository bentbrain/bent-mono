/**
 * The signed-in Fitness account on this iPhone.
 *
 * Signing in runs Clerk's OAuth sign-in once and keeps the refresh token in
 * the Keychain on this iPhone only, readable after the first unlock since
 * restart, as the Health device key is. Access tokens stay in memory and are refreshed shortly before they
 * expire. One refresh runs at a time; callers waiting for a token share it.
 * A refresh Clerk refuses ends the session. A refresh that cannot reach
 * Clerk keeps the session, so the app works offline with its saved data.
 */
export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number | null };

export type OAuthClient = {
  authorize(): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  revoke(refreshToken: string): Promise<void>;
};

export type SecretStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

/** Clerk refused the refresh token, so the user must sign in again. */
export class SessionExpired extends Error {
  constructor() {
    super("Your Fitness sign-in ended. Sign in again to continue.");
  }
}
/** Thrown by `OAuthClient.refresh` when Clerk refused the token. */
export class RefreshRejected extends Error {}

export type AccountState =
  | { status: "loading" }
  /** Signing out: no requests are made while this iPhone's data is removed. */
  | { status: "signingOut" }
  | { status: "signedOut"; message?: string }
  | { status: "signedIn"; owner: string | null };

const keys = { refresh: "fitness.account.refresh.v1", owner: "fitness.account.owner.v1" };
/** Refresh this long before the access token expires. */
const marginMs = 60_000;

export class Session {
  private state: AccountState = { status: "loading" };
  private listeners = new Set<() => void>();
  private access: { token: string; expiresAt: number | null } | null = null;
  private refreshing: Promise<string> | null = null;
  /**
   * Changes at each sign-in and sign-out. Work that began under an earlier
   * generation, such as a refresh or a request, must not act on this one.
   */
  private current = 0;
  /** Keychain writes and removals run one at a time, in the order requested. */
  private credentials: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly oauth: OAuthClient,
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;
  /** The current sign-in generation. */
  generation = () => this.current;
  private set(state: AccountState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /**
   * Runs a Keychain change after every change requested before it. Each one
   * checks the generation inside, so a change for an ended sign-in never
   * lands after, or on top of, a later sign-out or sign-in.
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.credentials.then(work, work);
    this.credentials = run.catch(() => undefined);
    return run;
  }

  /** Reads the saved sign-in. */
  async restore() {
    const refresh = await this.secrets.get(keys.refresh).catch(() => null);
    const owner = await this.secrets.get(keys.owner).catch(() => null);
    this.set(refresh ? { status: "signedIn", owner } : { status: "signedOut" });
  }

  /** Runs the sign-in and keeps its tokens. Throws when sign-in fails or is cancelled. */
  async signIn() {
    const generation = ++this.current;
    const tokens = await this.oauth.authorize();
    if (!tokens.refreshToken) throw new Error("Clerk did not return a refresh token. Allow offline access when you sign in.");
    const refreshToken = tokens.refreshToken;
    await this.exclusive(async () => {
      if (generation !== this.current) {
        this.revokeLater(refreshToken);
        throw new SessionExpired();
      }
      await this.secrets.set(keys.refresh, refreshToken);
      await this.secrets.remove(keys.owner);
    });
    // A sign-out during the Keychain write closed this sign-in; its own
    // cleanup, queued after the write, removes the token again.
    if (generation !== this.current) throw new SessionExpired();
    this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    this.set({ status: "signedIn", owner: null });
  }

  /** Records the account Fitness reported for the sign-in of `generation`. */
  async setOwner(owner: string, generation: number) {
    if (generation !== this.current || this.state.status !== "signedIn" || this.state.owner === owner) return;
    const saved = await this.exclusive(async () => {
      if (generation !== this.current) return false;
      await this.secrets.set(keys.owner, owner);
      return true;
    });
    if (saved && generation === this.current) this.set({ status: "signedIn", owner });
  }

  /**
   * An access token for Fitness. With `fresh`, a new one is issued even
   * when the current one is still valid, for a request that must not reuse
   * a token, such as connecting Apple Health.
   */
  async token({ fresh = false, generation }: { fresh?: boolean; generation?: number } = {}): Promise<string> {
    if (this.state.status !== "signedIn" || (generation !== undefined && generation !== this.current))
      throw new SessionExpired();
    const current = this.access;
    if (!fresh && current && (current.expiresAt === null || current.expiresAt - marginMs > this.now())) return current.token;
    return this.refresh();
  }

  /** The access token's expiry, after `token()`; null when unknown. */
  expiresAt() {
    return this.access?.expiresAt ?? null;
  }

  /** Discards the cached access token, after Fitness refused it. */
  invalidate(token: string) {
    if (this.access?.token === token) this.access = null;
  }

  /**
   * Refreshes the access token. A refresh that finishes after a sign-out or
   * a new sign-in revokes what it received and writes nothing, so it can
   * never restore an account that was signed out.
   */
  private refresh() {
    this.refreshing ??= (async () => {
      const generation = this.current;
      try {
        const saved = await this.secrets.get(keys.refresh);
        if (!saved || generation !== this.current) throw new SessionExpired();
        let tokens: Tokens;
        try {
          tokens = await this.oauth.refresh(saved);
        } catch (error) {
          if (error instanceof RefreshRejected) {
            if (generation === this.current) await this.end();
            throw new SessionExpired();
          }
          throw error;
        }
        const rotated = tokens.refreshToken;
        await this.exclusive(async () => {
          if (generation !== this.current) {
            if (rotated) this.revokeLater(rotated);
            throw new SessionExpired();
          }
          if (rotated && rotated !== saved) await this.secrets.set(keys.refresh, rotated);
        });
        if (generation !== this.current) throw new SessionExpired();
        this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
        return tokens.accessToken;
      } finally {
        if (generation === this.current) this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Closes the session to new requests at once, before its credentials are removed. */
  private close(state: AccountState) {
    this.current++;
    this.refreshing = null;
    this.access = null;
    this.set(state);
  }

  private async end(message = "Your Fitness sign-in ended. Sign in again to continue.") {
    this.close({ status: "signedOut", message });
    await this.exclusive(async () => {
      await this.secrets.remove(keys.refresh).catch(() => undefined);
      await this.secrets.remove(keys.owner).catch(() => undefined);
    });
  }

  /**
   * Asks Clerk to revoke a refresh token, without waiting. Revocation runs
   * outside the credential queue, so a slow request never holds up a
   * sign-out or a new sign-in.
   */
  private revokeLater(token: string) {
    void this.oauth.revoke(token).catch(() => undefined);
  }

  /**
   * Signs out: refuses requests at once, removes the sign-in from the
   * Keychain, runs `cleanup` to delete this iPhone's copy of the account,
   * then shows the sign-in screen and asks Clerk to revoke the token. The
   * sign-in screen appears only once the Keychain and `cleanup` are done; if
   * `cleanup` fails, it says what was left.
   */
  async signOut(cleanup: () => Promise<void> = async () => undefined) {
    this.close({ status: "signingOut" });
    const saved = await this.exclusive(async () => {
      const token = await this.secrets.get(keys.refresh).catch(() => null);
      await this.secrets.remove(keys.refresh).catch(() => undefined);
      await this.secrets.remove(keys.owner).catch(() => undefined);
      return token;
    });
    let message: string | undefined;
    try {
      await cleanup();
    } catch {
      message = "You're signed out, but some of your data on this iPhone could not be removed. Sign in and out again to remove it.";
    }
    this.set(message ? { status: "signedOut", message } : { status: "signedOut" });
    if (saved) this.revokeLater(saved);
  }
}
