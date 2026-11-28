import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { WorkoutReminders } from "../../modules/workout-activity";
import { useAccount } from "../account/AccountProvider";
import { reminders, useReminderSettings } from "../data/reminders";
import { ReminderRetry, openedDay, reminderPlan } from "../logic/reminders";

/**
 * Keeps the next 14 days of reminders scheduled while the account is open:
 * after each load or save changes the records or the plan, when the
 * reminder settings or the day change, and each time the app comes to the
 * foreground. Finishing today's session removes today's reminder. When iOS
 * refuses a reminder, the schedule runs again a minute later, only while
 * this sign-in lasts.
 */
export function useReminderSchedule() {
  const { owner, sync, settings, today } = useAccount();
  const preferences = useReminderSettings();
  const latest = useRef({ owner, settings, records: sync.records, preferences });
  const [session] = useState(
    () =>
      new ReminderRetry(reminders, () => {
        const { owner: account, settings: plan, records, preferences: chosen } = latest.current;
        return plan ? { owner: account, reminders: reminderPlan(plan, records, chosen, Date.now()) } : null;
      }),
  );

  useEffect(() => {
    latest.current = { owner, settings, records: sync.records, preferences };
    session.run(false);
  }, [session, owner, settings, sync.records, preferences, today]);

  useEffect(() => {
    // Time has passed, and notification permission may have changed in Settings.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") session.run(true);
    });
    return () => {
      subscription.remove();
      session.stop();
    };
  }, [session]);
}

/** The day of the reminder that opened the app, once, if it belongs to `owner`. */
export function takeOpenedReminder(owner: string) {
  return openedDay(WorkoutReminders?.takeOpened(), owner);
}
