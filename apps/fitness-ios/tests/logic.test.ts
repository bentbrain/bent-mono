import { describe, expect, test } from "bun:test";
import type { EnrollOutcome, SyncStatus } from "../modules/fitness-health";
import { SignInCancelled, connect } from "../src/logic/connect";
import { copy, countLines, enrollMessage, fitnessHost, guidance } from "../src/logic/copy";
import { cutoffFor } from "../src/logic/cutoff";
import { manualRevocationNotice, screenFor } from "../src/logic/screens";

const base: SyncStatus = {
  state: "signedOut",
  healthAvailable: true,
  origin: "https://fitness.bent.build",
  pendingRevocations: 0,
  retryPending: false,
};

describe("screens", () => {
  test("follow the key state", () => {
    expect(screenFor(null)).toBe("loading");
    expect(screenFor(base)).toBe("signIn");
    expect(screenFor({ ...base, state: "consentPending" })).toBe("consent");
    expect(screenFor({ ...base, state: "invalid" })).toBe("reconnect");
    expect(screenFor({ ...base, state: "locked" })).toBe("locked");
  });

  test("an active key shows the Health step until it starts the first sync", () => {
    const active: SyncStatus = { ...base, state: "active", awaitingHealthStep: true, lastSyncAt: null };
    expect(screenFor(active)).toBe("health");
    // The wait is stored natively, so a relaunch returns to the step.
    expect(screenFor({ ...active, backfillStarted: true })).toBe("health");
    expect(screenFor({ ...active, awaitingHealthStep: false })).toBe("status");
  });
});

describe("manual revocations", () => {
  test("keys Fitness would not revoke stay on the notice after a disconnect, until dismissed", () => {
    expect(manualRevocationNotice(null)).toBeNull();
    expect(manualRevocationNotice(base)).toBeNull();
    expect(manualRevocationNotice({ ...base, manualRevocations: 0, manualRevocationsRevision: 2 })).toBeNull();
    // Signed out after a disconnect: the sign-in screen shows it.
    expect(screenFor({ ...base, manualRevocations: 1 })).toBe("signIn");
    expect(manualRevocationNotice({ ...base, manualRevocations: 1, manualRevocationsRevision: 1 })).toEqual({
      text: "1 earlier key could not be revoked from this iPhone. Revoke it under Manage account → API keys in Fitness.",
      revision: 1,
    });
    expect(manualRevocationNotice({ ...base, state: "invalid", manualRevocations: 2 })?.text).toContain(
      "2 earlier keys",
    );
    expect(manualRevocationNotice({ ...base, state: "active", manualRevocations: 2 })?.text).toContain(
      "2 earlier keys",
    );
    // Before the first unlock the count is unknown.
    expect(manualRevocationNotice({ ...base, state: "locked", manualRevocations: 2 })).toBeNull();
  });

  test("dismissing names the revision shown, so a key recorded later stays on the notice", () => {
    // Three keys recorded, two dismissed earlier: the notice shows one, at revision 3.
    expect(manualRevocationNotice({ ...base, manualRevocations: 1, manualRevocationsRevision: 3 })).toEqual({
      text: expect.stringContaining("1 earlier key"),
      revision: 3,
    });
    // A status from before revisions were reported dismisses what it shows.
    expect(manualRevocationNotice({ ...base, manualRevocations: 2 })?.revision).toBe(2);
  });
});

describe("cutoff", () => {
  const now = new Date(2026, 10, 20, 12).getTime();
  test("30 days and 12 months start at local midnight", () => {
    expect(new Date(cutoffFor("30d", now))).toEqual(new Date(2026, 9, 21));
    expect(new Date(cutoffFor("1y", now))).toEqual(new Date(2025, 10, 20));
  });
  test("all of Health starts in 2000", () => {
    expect(new Date(cutoffFor("all", now)).getUTCFullYear()).toBe(2000);
  });
});

describe("connect", () => {
  const consent: EnrollOutcome = { kind: "consentPending", email: "a@example.com", accountTimezone: "UTC" };
  const begin = async () => 1;
  const signedIn =
    (token: string, expiresAt: number | null = null) =>
    async () => ({ token, expiresAt });

  test("retries busy replies with the same token after exactly Retry-After", async () => {
    const tokens: string[] = [];
    const waits: number[] = [];
    const replies: EnrollOutcome[] = [
      { kind: "failed", action: "retrySameToken", code: "issuance_pending", retryAfter: 10 },
      { kind: "failed", action: "retrySameToken", code: "rate_limited", retryAfter: 120 },
      { kind: "failed", action: "retrySameToken", code: "auth_unavailable", retryAfter: null },
      consent,
    ];
    let authorized = 0;
    const result = await connect({
      authorize: async () => ({ token: `oat_${++authorized}`, expiresAt: null }),
      begin,
      enroll: async (token) => {
        tokens.push(token);
        return replies.shift() ?? consent;
      },
      sleep: async (ms) => void waits.push(ms),
      now: () => 0,
    });
    expect(result).toEqual(consent);
    expect(tokens).toEqual(["oat_1", "oat_1", "oat_1", "oat_1"]);
    expect(waits).toEqual([10_000, 120_000, 10_000]);
    expect(authorized).toBe(1);
  });

  test("a stale enrollment retries at once with the same token", async () => {
    const waits: number[] = [];
    const replies: EnrollOutcome[] = [
      { kind: "failed", action: "retrySameToken", code: "stale_enrollment", retryAfter: 0 },
      consent,
    ];
    const result = await connect({
      authorize: signedIn("oat_1"),
      begin,
      enroll: async () => replies.shift() ?? consent,
      sleep: async (ms) => void waits.push(ms),
      now: () => 0,
    });
    expect(result).toEqual(consent);
    expect(waits).toEqual([0]);
  });

  test("ends the attempt when the token would expire before the retry", async () => {
    let calls = 0;
    const result = await connect({
      authorize: signedIn("oat_1", 60_000),
      begin,
      enroll: async () => {
        calls++;
        return { kind: "failed", action: "retrySameToken", code: "rate_limited", retryAfter: 3600 };
      },
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(result).toEqual({ kind: "tokenExpires", retryAfter: 3600 });
    expect(calls).toBe(1);
  });

  test("stops retrying after three waits", async () => {
    const busy: EnrollOutcome = { kind: "failed", action: "retrySameToken", code: "rate_limited", retryAfter: 5 };
    let calls = 0;
    const result = await connect({
      authorize: signedIn("oat_1"),
      begin,
      enroll: async () => {
        calls++;
        return busy;
      },
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(result).toEqual(busy);
    expect(calls).toBe(4);
  });

  test("ends on a reply that needs a fresh sign-in", async () => {
    let calls = 0;
    const result = await connect({
      authorize: signedIn("oat_1"),
      begin,
      enroll: async () => {
        calls++;
        return { kind: "failed", action: "reauthorize", code: "enrollment_token_used" };
      },
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(result).toEqual({ kind: "failed", action: "reauthorize", code: "enrollment_token_used" });
    expect(calls).toBe(1);
  });

  test("reports a cancelled or failed sign-in", async () => {
    const enroll = async () => consent;
    const sleep = async () => undefined;
    const now = () => 0;
    expect(
      await connect({ authorize: async () => Promise.reject(new SignInCancelled()), begin, enroll, sleep, now }),
    ).toEqual({
      kind: "cancelled",
    });
    expect(
      await connect({ authorize: async () => Promise.reject(new Error("state_mismatch")), begin, enroll, sleep, now }),
    ).toEqual({ kind: "signInFailed", message: "state_mismatch" });
  });

  test("every request of a sign-in passes the attempt that began before it", async () => {
    const order: string[] = [];
    const attempts: number[] = [];
    const replies: EnrollOutcome[] = [
      { kind: "failed", action: "retrySameToken", code: "rate_limited", retryAfter: 1 },
      { kind: "failed", action: "retrySameToken", code: "auth_unavailable", retryAfter: null },
      consent,
    ];
    const result = await connect({
      authorize: async () => {
        order.push("authorize");
        return { token: "oat_1", expiresAt: null };
      },
      begin: async () => {
        order.push("begin");
        return 4;
      },
      enroll: async (_token, _later, attempt) => {
        attempts.push(attempt);
        return replies.shift() ?? consent;
      },
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(result).toEqual(consent);
    expect(order).toEqual(["begin", "authorize"]);
    expect(attempts).toEqual([4, 4, 4]);
  });

  test("a disconnect during a retry wait ends the sign-in", async () => {
    let calls = 0;
    const result = await connect({
      authorize: signedIn("oat_1"),
      begin,
      enroll: async () => {
        calls++;
        return calls === 1
          ? { kind: "failed", action: "retrySameToken", code: "rate_limited", retryAfter: 1 }
          : { kind: "superseded" };
      },
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(result).toEqual({ kind: "superseded" });
    expect(calls).toBe(2);
  });

  test("passes revoke-later through", async () => {
    let later: boolean | undefined;
    await connect(
      {
        authorize: signedIn("oat_1"),
        begin,
        enroll: async (_token, revokeLater) => {
          later = revokeLater;
          return consent;
        },
        sleep: async () => undefined,
        now: () => 0,
      },
      true,
    );
    expect(later).toBe(true);
  });
});

describe("copy", () => {
  test("every enrollment refusal has its own guidance", () => {
    const codes = ["insufficient_scope", "client_not_allowed", "not_invited", "enrollment_unavailable"];
    const messages = codes.map((code) => enrollMessage({ kind: "failed", action: "refused", code, message: "server" }));
    expect(new Set(messages).size).toBe(codes.length);
    expect(messages.every((message) => message !== "server")).toBe(true);
    expect(enrollMessage({ kind: "failed", action: "deviceLimit", message: "x" })).toContain("API keys");
    expect(enrollMessage({ kind: "pendingRevocations", count: 2 })).toContain("2 earlier keys");
    expect(enrollMessage({ kind: "failed", action: "reauthorize", code: "issuance_failed" })).toContain(
      "Sign in again",
    );
  });

  test("every sync error code has guidance", () => {
    for (const code of ["transport", "key_invalid", "locked", "auth_unavailable", "needs_correction", "http_502"])
      expect(guidance(code)).not.toContain("stopped (");
    expect(guidance("something_new")).toContain("something_new");
    expect(guidance(null)).toBeNull();
  });

  test("counts read from codes, per type", () => {
    const lines = countLines({ "weight.new": 3, "weight.already_imported": 1, "run.new": 2 }, "weight");
    expect(lines).toEqual([
      { label: "added", value: 3 },
      { label: "already synced", value: 1 },
    ]);
    expect(countLines(undefined, "run")).toEqual([]);
  });

  test("the consent copy states the promise and the destination", () => {
    expect(copy.consent.destination(fitnessHost("https://fitness.bent.build"))).toContain("fitness.bent.build");
    expect(copy.consent.promise.join(" ")).toContain("background");
    expect(copy.consent.disconnect).toContain("revokes");
    expect(copy.status.withoutDistance(1)).toContain("1 run was");
    expect(copy.status.distanceAccess(2)).toContain("2 runs are waiting for distance access");
    expect(copy.status.sendWithoutDistance(1)).toBe("Send 1 run without distance");
    expect(copy.status.sendWithoutDistance(3)).toBe("Send 3 runs without distance");
    expect(copy.status.manualRevocations(1)).toContain("API keys");
    expect(copy.signIn.tryLater(3600)).toContain("3600 seconds");
  });
});
