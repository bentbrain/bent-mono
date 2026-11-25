import type { EnrollOutcome } from "../../modules/fitness-health";

export type ConnectResult =
  | { kind: "cancelled" }
  | { kind: "signInFailed"; message: string }
  | { kind: "tokenExpires"; retryAfter: number }
  | EnrollOutcome;

/** A one-time access token and when it stops working, in ms since 1970. */
export type SignedIn = { token: string; expiresAt: number | null };

export type ConnectDeps = {
  /** Runs the OAuth sign-in and returns the access token. */
  authorize(): Promise<SignedIn>;
  enroll(token: string, revokeLater: boolean): Promise<EnrollOutcome>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

/** Thrown by `authorize` when the user closes the sign-in sheet. */
export class SignInCancelled extends Error {}

const backoffMs = [2_000, 5_000, 10_000];
/** Time a token must still have left when the retry is sent. */
const tokenMarginMs = 30_000;

/**
 * Signs in and exchanges the one-time token for a device key. Busy and
 * unavailable replies, and a stale enrollment sequence, are retried with
 * the same token after exactly `Retry-After`, or a short backoff without
 * one. If the token would expire before the retry, the attempt ends and the
 * user signs in again later. Every other result ends the attempt, and the
 * token goes out of scope.
 */
export async function connect(deps: ConnectDeps, revokeLater = false): Promise<ConnectResult> {
  let signedIn: SignedIn;
  try {
    signedIn = await deps.authorize();
  } catch (error) {
    if (error instanceof SignInCancelled) return { kind: "cancelled" };
    return { kind: "signInFailed", message: error instanceof Error ? error.message : "Sign-in failed." };
  }
  for (let attempt = 0; ; attempt++) {
    const outcome = await deps.enroll(signedIn.token, revokeLater);
    if (outcome.kind !== "failed" || outcome.action !== "retrySameToken" || attempt >= backoffMs.length) return outcome;
    const wait = outcome.retryAfter === null ? (backoffMs[attempt] ?? 10_000) : outcome.retryAfter * 1000;
    if (signedIn.expiresAt !== null && deps.now() + wait > signedIn.expiresAt - tokenMarginMs)
      return { kind: "tokenExpires", retryAfter: Math.ceil(wait / 1000) };
    await deps.sleep(wait);
  }
}
