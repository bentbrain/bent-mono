import type { EnrollOutcome } from "../../modules/fitness-health";

export type ConnectResult = { kind: "cancelled" } | { kind: "signInFailed"; message: string } | EnrollOutcome;

export type ConnectDeps = {
  /** Runs the OAuth sign-in and returns the access token, or null if cancelled. */
  authorize(): Promise<string>;
  enroll(token: string, revokeLater: boolean): Promise<EnrollOutcome>;
  sleep(ms: number): Promise<void>;
};

/** Thrown by `authorize` when the user closes the sign-in sheet. */
export class SignInCancelled extends Error {}

const backoffMs = [2_000, 5_000, 10_000];
const maxWaitMs = 60_000;

/**
 * Signs in and exchanges the one-time token for a device key. Busy and
 * unavailable replies are retried with the same token after `Retry-After`;
 * every other result ends the attempt, and the token goes out of scope.
 */
export async function connect(deps: ConnectDeps, revokeLater = false): Promise<ConnectResult> {
  let token: string;
  try {
    token = await deps.authorize();
  } catch (error) {
    if (error instanceof SignInCancelled) return { kind: "cancelled" };
    return { kind: "signInFailed", message: error instanceof Error ? error.message : "Sign-in failed." };
  }
  for (let attempt = 0; ; attempt++) {
    const outcome = await deps.enroll(token, revokeLater);
    if (outcome.kind !== "failed" || outcome.action !== "retrySameToken" || attempt >= backoffMs.length)
      return outcome;
    const wait = outcome.retryAfter === null ? backoffMs[attempt] ?? maxWaitMs : outcome.retryAfter * 1000;
    await deps.sleep(Math.min(wait, maxWaitMs));
  }
}
