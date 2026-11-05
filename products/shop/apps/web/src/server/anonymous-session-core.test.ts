import { describe, expect, it } from "vitest";

import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousOwnerId,
  anonymousSessionCookieOptions,
  createAnonymousSessionToken,
} from "./anonymous-session-core";

describe("anonymous session capability", () => {
  it("uses a 32-byte host-only cookie capability with hardened attributes", () => {
    expect(ANONYMOUS_SESSION_COOKIE).toBe("__Host-forever_tee_session");
    expect(createAnonymousSessionToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(anonymousSessionCookieOptions).toEqual({
      httpOnly: true,
      maxAge: 31_536_000,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
    expect("domain" in anonymousSessionCookieOptions).toBe(false);
  });

  it("derives a stable owner ID without retaining the raw capability", async () => {
    const token = "a".repeat(43);
    const first = await anonymousOwnerId(token);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await anonymousOwnerId(token)).toBe(first);
    expect(first).not.toContain(token);
  });
});
