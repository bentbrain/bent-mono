import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { WorkoutReminders } from "../../modules/workout-activity";
import { session } from "../account/AccountProvider";
import { appScheme } from "../data/widget";
import { TapBuffer, tapTarget } from "../logic/launch";
import type { AppTap } from "../logic/launch";
import { widgetLink } from "../logic/widget";
import type { WidgetLink } from "../logic/widget";

export type TapTarget = { kind: "reminder"; day: string } | { kind: "widget"; link: WidgetLink };

/**
 * Reminder and widget taps while the app runs, in the order they arrive.
 * Listening starts with the app, so taps made while the account or plan
 * is still loading wait here, and the latest of them wins whichever kind
 * it is. Each tap records the sign-in it arrived during, so one made before
 * a session ended never opens in a later one. A reminder tapped to launch
 * the app arrives before any of these, through `takeOpenedReminder`.
 */
const taps = new TapBuffer<AppTap<WidgetLink>>();
Linking.addEventListener("url", ({ url }) => {
  const link = widgetLink(url, appScheme);
  if (link) taps.push({ kind: "widget", link, generation: session.generation() });
});
WorkoutReminders?.addListener("onReminderOpened", (tap) =>
  taps.push({ kind: "reminder", ...tap, generation: session.generation() }),
);

/**
 * Opens tapped reminders and widget links: the latest tap made while the
 * app loaded once navigation listens, then each tap as it arrives. Taps
 * from another sign-in, and reminder taps for another account, are ignored.
 */
export function useAppTaps(owner: string, open: (target: TapTarget) => void) {
  // The sign-in this navigation opened under. A tap from an ended sign-in never opens.
  const [generation] = useState(() => session.generation());
  const handler = useRef({ owner, open });
  useEffect(() => {
    handler.current = { owner, open };
  }, [owner, open]);
  useEffect(
    () =>
      taps.listen((tap) => {
        const target = tapTarget(tap, handler.current.owner, generation);
        if (target) handler.current.open(target);
      }),
    [generation],
  );
}
