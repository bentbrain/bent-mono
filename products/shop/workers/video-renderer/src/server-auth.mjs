import { timingSafeEqual } from "node:crypto";

export function isAuthorized(authorization, expectedToken) {
  if (!expectedToken || !authorization?.startsWith("Bearer ")) return false;
  const receivedToken = authorization.slice("Bearer ".length);
  const received = Buffer.from(receivedToken);
  const expected = Buffer.from(expectedToken);
  return received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected);
}
