import { describe, expect, it } from "vitest";

import { storefrontSecurityHeaders } from "./security-headers";

const COMMON_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=()",
  },
  { key: "X-Frame-Options", value: "DENY" },
];

describe("storefront security headers", () => {
  it("protects content types, referrers, browser capabilities, and framing", () => {
    expect(storefrontSecurityHeaders({
      includeStrictTransportSecurity: false,
    })).toEqual(COMMON_HEADERS);
  });

  it("adds HSTS only when the response is served in production", () => {
    expect(storefrontSecurityHeaders({
      includeStrictTransportSecurity: true,
    })).toEqual([
      ...COMMON_HEADERS,
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000",
      },
    ]);
  });
});
