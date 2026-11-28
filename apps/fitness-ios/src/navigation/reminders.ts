import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { WorkoutReminders } from "../../modules/workout-activity";
import { useAccount } from "../account/AccountProvider";
import { reminders, useReminderSettings } from "../data/reminders";
import { openedDay, reminderPlan } from "../logic/reminders";

/** How long to wait before trying again when iOS refused a reminder. */
const retryMs = 60_000;

/**
 * Keeps the next 14 days of reminders scheduled while the account is open:
 * after each load or save changes the records or the plan, when the
 * reminder settings or the day change, and each time the app comes to the
 * foreground. Finishing today's session removes today's reminder. When iOS
 * refuses a reminder, the schedule runs again a minute later.
 */
export function useReminderSchedule() {
  const { owner, sync, settings, today } = useAccount();
  const preferences = useReminderSettings();
  const latest = useRef({ owner, settings, records: sync.records, preferences });
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback((force: boolean) => {
    const { owner: account, settings: plan, records, preferences: chosen } = latest.current;
    if (!plan) return;
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    void reminders.schedule(account, reminderPlan(plan, records, chosen, Date.now()), force).then((result) => {
      if (result === "failed" && !retry.current) retry.current = setTimeout(() => run(true), retryMs);
    });
  }, []);

  useEffect(() => {
    latest.current = { owner, settings, records: sync.records, preferences };
    run(false);
  }, [run, owner, settings, sync.records, preferences, today]);

  useEffect(() => {
    // Time has passed, and notification permission may have changed in Settings.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") run(true);
    });
    return () => {
      subscription.remove();
      if (retry.current) clearTimeout(retry.current);
      retry.current = null;
    };
  }, [run]);
}

/**
 * Opens a tapped reminder's day while the app runs. Taps for another
 * account, such as one signed out since, are ignored.
 */
export function useReminderTaps(owner: string, open: (day: string) => void) {
  const handler = useRef({ owner, open });
  useEffect(() => {
    handler.current = { owner, open };
  }, [owner, open]);
  useEffect(() => {
    const native = WorkoutReminders;
    if (!native) return;
    const subscription = native.addListener("onReminderOpened", (tap) => {
      const day = openedDay(tap, handler.current.owner);
      if (day) handler.current.open(day);
    });
    return () => subscription.remove();
  }, []);
}

/** The day of the reminder that opened the app, once, if it belongs to `owner`. */
export function takeOpenedReminder(owner: string) {
  return openedDay(WorkoutReminders?.takeOpened(), owner);
}
