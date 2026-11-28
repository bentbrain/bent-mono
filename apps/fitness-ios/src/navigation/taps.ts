import { useEffect, useRef } from "react";
import { Linking } from "react-native";
import { WorkoutReminders } from "../../modules/workout-activity";
import { appScheme } from "../data/widget";
import { TapBuffer } from "../logic/launch";
import { openedDay } from "../logic/reminders";
import { widgetLink } from "../logic/widget";
import type { WidgetLink } from "../logic/widget";

type AppTap = { kind: "reminder"; day: string; owner: string } | { kind: "widget"; link: WidgetLink };
export type TapTarget = { kind: "reminder"; day: string } | { kind: "widget"; link: WidgetLink };

/**
 * Reminder and widget taps while the app runs, in the order they arrive.
 * Listening starts with the app, so taps made while the account or plan
 * is still loading wait here, and the latest of them wins whichever kind
 * it is. A reminder tapped to launch the app arrives before any of these,
 * through `takeOpenedReminder`.
 */
const taps = new TapBuffer<AppTap>();
Linking.addEventListener("url", ({ url }) => {
  const link = widgetLink(url, appScheme);
  if (link) taps.push({ kind: "widget", link });
});
WorkoutReminders?.addListener("onReminderOpened", (tap) => taps.push({ kind: "reminder", ...tap }));

/**
 * Opens tapped reminders and widget links: the latest tap made while the
 * app loaded once navigation listens, then each tap as it arrives. Reminder
 * taps for another account, such as one signed out since, are ignored.
 */
export function useAppTaps(owner: string, open: (target: TapTarget) => void) {
  const handler = useRef({ owner, open });
  useEffect(() => {
    handler.current = { owner, open };
  }, [owner, open]);
  useEffect(
    () =>
      taps.listen((tap) => {
        if (tap.kind === "widget") return handler.current.open(tap);
        const day = openedDay(tap, handler.current.owner);
        if (day) handler.current.open({ kind: "reminder", day });
      }),
    [],
  );
}
