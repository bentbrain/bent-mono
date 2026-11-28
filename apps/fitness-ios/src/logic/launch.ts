/*
 * Where the signed-in app opens at launch. A reminder tapped to open the
 * app comes first, then a widget tapped to open it, then a Health step
 * waiting for consent or for its Start button. A tap on a reminder or the
 * widget while the app runs replaces the launch destination: once
 * navigation is ready it opens at once, and before then it becomes the
 * launch destination. These rules stay apart from React Native for Bun tests.
 */

import { openedDay } from "./reminders";

export type LaunchTarget<Link> = (
  | { kind: "reminder"; day: string }
  | { kind: "widget"; link: Link }
  | { kind: "health" }
) & {
  /** A tap that came before navigation was ready. */
  early?: boolean;
  /** The router's version when it was worked out (0 when absent); a newer tap makes it stale. */
  version?: number;
};

export type LaunchSources<Link> = {
  /** The day of the reminder that opened the app, if any. */
  reminder: () => string | null;
  /** The widget link that opened the app, if any. */
  widget: () => Promise<Link | null>;
  /** Whether a Health connection is waiting at its consent or Health step. */
  health: () => Promise<boolean>;
};

/** Works out the launch destination once, unless a newer tap replaces it. */
export class LaunchRouter<Link> {
  private replaced = false;
  /** Rises with each tap that replaces the destination. */
  private version = 0;
  /** A tap that came before navigation was ready, to open in place of the launch destination. */
  private early: LaunchTarget<Link> | null = null;

  /**
   * A reminder or widget tap while the app runs. The launch destination no
   * longer applies. `early` is the tap's destination when navigation isn't
   * ready to open it yet.
   */
  replace(early: LaunchTarget<Link> | null = null) {
    this.replaced = true;
    this.version += 1;
    this.early = early ?? this.early;
  }

  /** The launch destination, or null for none or when a newer tap replaced it. */
  async resolve(sources: LaunchSources<Link>): Promise<LaunchTarget<Link> | null> {
    if (this.replaced) {
      const early = this.early;
      this.early = null;
      return early ? { ...early, early: true, version: this.version } : null;
    }
    const day = sources.reminder();
    if (day) return { kind: "reminder", day, version: this.version };
    const link = await sources.widget().catch(() => null);
    if (this.replaced) return null;
    if (link) return { kind: "widget", link, version: this.version };
    const health = await sources.health().catch(() => false);
    if (this.replaced || !health) return null;
    return { kind: "health", version: this.version };
  }

  /** Runs `open` for the destination unless a newer tap replaced it after it was worked out. */
  openIfCurrent(target: LaunchTarget<Link> | null, open: (target: LaunchTarget<Link>) => void) {
    if (target && (target.version ?? 0) === this.version) open(target);
  }
}

/**
 * Holds the latest tap until something listens for it, so a tap that
 * arrives while the app is still loading the account is opened once
 * navigation mounts. A listener gets taps as they arrive.
 */
export class TapBuffer<T> {
  private pending: T | null = null;
  private listener: ((tap: T) => void) | null = null;

  push(tap: T) {
    if (this.listener) this.listener(tap);
    else this.pending = tap;
  }

  /** Delivers a waiting tap at once, then each later one. Returns the unsubscribe. */
  listen(listener: (tap: T) => void) {
    this.listener = listener;
    const waiting = this.pending;
    this.pending = null;
    if (waiting !== null) listener(waiting);
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
}

/**
 * What launched the app, such as the widget link it opened with, only when
 * navigation opens under the sign-in the app launched with. A session that
 * ended before navigation opened takes its launch link with it.
 */
export function forLaunchSignIn<T>(value: T | null, launchGeneration: number, generation: number): T | null {
  return generation === launchGeneration ? value : null;
}

/** A reminder or widget tap while the app runs, with the sign-in it arrived during. */
export type AppTap<Link> = ({ kind: "reminder"; day: string; owner: string } | { kind: "widget"; link: Link }) & {
  generation: number;
};

/**
 * Where a tap opens, or null when it shouldn't: a tap from another sign-in,
 * such as one made before the session expired and the same account signed
 * in again, or a reminder for another account.
 */
export function tapTarget<Link>(
  tap: AppTap<Link>,
  owner: string,
  generation: number,
): { kind: "reminder"; day: string } | { kind: "widget"; link: Link } | null {
  if (tap.generation !== generation) return null;
  if (tap.kind === "widget") return { kind: "widget", link: tap.link };
  const day = openedDay(tap, owner);
  return day ? { kind: "reminder", day } : null;
}
