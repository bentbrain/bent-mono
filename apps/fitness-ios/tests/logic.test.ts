import { describe, expect, test } from "bun:test";
import type { EnrollOutcome, SyncStatus } from "../modules/fitness-health";
import { SignInCancelled, connect } from "../src/logic/connect";
import { copy, countLines, enrollMessage, fitnessHost, guidance } from "../src/logic/copy";
import { cutoffFor } from "../src/logic/cutoff";
import { screenFor } from "../src/logic/screens";

const base: SyncStatus = {
  state: "signedOut",
  healthAvailable: true,
  origin: "https://fitness.bent.build",
  pendingRevocations: 0,
  retryPending: false,
};

describe("screens", () => {
  test("follow the key state", () => {
    expect(screenFor(null, false)).toBe("loading");
    expect(screenFor(base, false)).toBe("signIn");
    expect(screenFor({ ...base, state: "consentPending" }, false)).toBe("consent");
    expect(screenFor({ ...base, state: "invalid" }, false)).toBe("reconnect");
  });

  test("an active key shows the Health step until the first sync starts", () => {
    const active: SyncStatus = { ...base, state: "active", backfilling: true, lastSyncAt: null };
    expect(screenFor(active, false)).toBe("health");
    expect(screenFor(active, true)).toBe("status");
    expect(screenFor({ ...active, lastSyncAt: 1 }, false)).toBe("status");
    expect(screenFor({ ...active, backfilling: false }, false)).toBe("status");
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

  test("retries busy replies with the same token after Retry-After", async () => {
    const tokens: string[] = [];
    const waits: number[] = [];
    const replies: EnrollOutcome[] = [
      { kind: "failed", action: "retrySameToken", code: "issuance_pending", retryAfter: 10 },
      { kind: "failed", action: "retrySameToken", code: "auth_unavailable", retryAfter: null },
      consent,
    ];
    let authorized = 0;
    const result = await connect({
      authorize: async () => `oat_${++authorized}`,
      enroll: async (token) => {
        tokens.push(token);
        return replies.shift() ?? consent;
      },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(result).toEqual(consent);
    expect(tokens).toEqual(["oat_1", "oat_1", "oat_1"]);
    expect(waits).toEqual([10_000, 5_000]);
    expect(authorized).toBe(1);
  });

  test("stops retrying after three waits", async () => {
    const busy: EnrollOutcome = { kind: "failed", action: "retrySameToken", code: "rate_limited", retryAfter: 600 };
    let calls = 0;
    const waits: number[] = [];
    const result = await connect({
      authorize: async () => "oat_1",
      enroll: async () => {
        calls++;
        return busy;
      },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(result).toEqual(busy);
    expect(calls).toBe(4);
    expect(waits).toEqual([60_000, 60_000, 60_000]);
  });

  test("ends on a reply that needs a fresh sign-in", async () => {
    let calls = 0;
    const result = await connect({
      authorize: async () => "oat_1",
      enroll: async () => {
        calls++;
        return { kind: "failed", action: "reauthorize", code: "enrollment_token_used" };
      },
      sleep: async () => undefined,
    });
    expect(result).toEqual({ kind: "failed", action: "reauthorize", code: "enrollment_token_used" });
    expect(calls).toBe(1);
  });

  test("reports a cancelled or failed sign-in", async () => {
    const enroll = async () => consent;
    const sleep = async () => undefined;
    expect(await connect({ authorize: async () => Promise.reject(new SignInCancelled()), enroll, sleep })).toEqual({
      kind: "cancelled",
    });
    expect(await connect({ authorize: async () => Promise.reject(new Error("state_mismatch")), enroll, sleep })).toEqual({
      kind: "signInFailed",
      message: "state_mismatch",
    });
  });

  test("passes revoke-later through", async () => {
    let later: boolean | undefined;
    await connect(
      {
        authorize: async () => "oat_1",
        enroll: async (_token, revokeLater) => {
          later = revokeLater;
          return consent;
        },
        sleep: async () => undefined,
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
    expect(enrollMessage({ kind: "failed", action: "reauthorize", code: "issuance_failed" })).toContain("Sign in again");
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
  });
});
