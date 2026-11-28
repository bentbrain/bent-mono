import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { WorkoutReminders } from "../../modules/workout-activity";
import { useAccount } from "../account/AccountProvider";
import { reminders, useReminderSettings } from "../data/reminders";
import { reminderPlan } from "../logic/reminders";
import { isDay } from "../screens/week/logic";

/**
 * Keeps the next 14 days of reminders scheduled while the account is open:
 * after each load or save changes the records or the plan, when the
 * reminder settings or the day change, and each time the app comes to the
 * foreground. Finishing today's session removes today's reminder.
 */
export function useReminderSchedule() {
  const { sync, settings, today } = useAccount();
  const preferences = useReminderSettings();
  const latest = useRef({ settings, records: sync.records, preferences });

  useEffect(() => {
    latest.current = { settings, records: sync.records, preferences };
    if (!settings) return;
    void reminders.schedule(reminderPlan(settings, sync.records, preferences, Date.now()));
  }, [settings, sync.records, preferences, today]);

  useEffect(() => {
    // Time has passed, and notification permission may have changed in Settings.
    const subscription = AppState.addEventListener("change", (state) => {
      const { settings: plan, records, preferences: chosen } = latest.current;
      if (state === "active" && plan) void reminders.schedule(reminderPlan(plan, records, chosen, Date.now()), true);
    });
    return () => subscription.remove();
  }, []);
}

/**
 * Opens a tapped reminder's day: `open` runs for a tap while the app
 * runs, and for the tap that opened the app once navigation is ready.
 */
export function useReminderTaps(open: (day: string) => void) {
  const handler = useRef(open);
  useEffect(() => {
    handler.current = open;
  }, [open]);
  useEffect(() => {
    const native = WorkoutReminders;
    if (!native) return;
    const subscription = native.addListener("onReminderOpened", ({ day }) => {
      if (isDay(day)) handler.current(day);
    });
    return () => subscription.remove();
  }, []);
}

/** The day of the reminder that opened the app, once. */
export function takeOpenedReminder() {
  const day = WorkoutReminders?.takeOpened() ?? null;
  return isDay(day ?? undefined) ? day : null;
}
