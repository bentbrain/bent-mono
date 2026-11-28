/*
 * Where the signed-in app opens at launch. A reminder tapped to open the
 * app comes first, then a widget tapped to open it, then a Health step
 * waiting for consent or for its Start button. A tap on a reminder or the
 * widget while the app runs replaces the launch destination: once
 * navigation is ready it opens at once, and before then it becomes the
 * launch destination. These rules stay apart from React Native for Bun tests.
 */

export type LaunchTarget<Link> = (
  | { kind: "reminder"; day: string }
  | { kind: "widget"; link: Link }
  | { kind: "health" }
) & {
  /** A tap that came before navigation was ready. */
  early?: boolean;
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
  /** A tap that came before navigation was ready, to open in place of the launch destination. */
  private early: LaunchTarget<Link> | null = null;

  /**
   * A reminder or widget tap while the app runs. The launch destination no
   * longer applies. `early` is the tap's destination when navigation isn't
   * ready to open it yet.
   */
  replace(early: LaunchTarget<Link> | null = null) {
    this.replaced = true;
    this.early = early ?? this.early;
  }

  /** The launch destination, or null for none or when a newer tap replaced it. */
  async resolve(sources: LaunchSources<Link>): Promise<LaunchTarget<Link> | null> {
    if (this.replaced) {
      const early = this.early;
      this.early = null;
      return early ? { ...early, early: true } : null;
    }
    const day = sources.reminder();
    if (day) return { kind: "reminder", day };
    const link = await sources.widget().catch(() => null);
    if (this.replaced) return null;
    if (link) return { kind: "widget", link };
    const health = await sources.health().catch(() => false);
    if (this.replaced || !health) return null;
    return { kind: "health" };
  }

  /** Runs `open` for the destination unless a newer tap replaced it after it was worked out. */
  openIfCurrent(target: LaunchTarget<Link> | null, open: (target: LaunchTarget<Link>) => void) {
    if (target && (!this.replaced || target.early)) open(target);
  }
}
