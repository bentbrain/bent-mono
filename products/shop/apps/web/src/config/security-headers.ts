interface SecurityHeaderOptions {
  readonly includeStrictTransportSecurity: boolean;
}

interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

const COMMON_SECURITY_HEADERS: readonly SecurityHeader[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=()",
  },
  { key: "X-Frame-Options", value: "DENY" },
];

const STRICT_TRANSPORT_SECURITY: SecurityHeader = {
  key: "Strict-Transport-Security",
  value: "max-age=63072000",
};

export function storefrontSecurityHeaders({
  includeStrictTransportSecurity,
}: SecurityHeaderOptions): SecurityHeader[] {
  return includeStrictTransportSecurity
    ? [...COMMON_SECURITY_HEADERS, STRICT_TRANSPORT_SECURITY]
    : [...COMMON_SECURITY_HEADERS];
}
