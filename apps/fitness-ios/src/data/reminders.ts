import { useSyncExternalStore } from "react";
import { WorkoutReminders } from "../../modules/workout-activity";
import { ReminderScheduler, parseReminderSettings } from "../logic/reminders";
import type { ReminderCenter, ReminderSettings } from "../logic/reminders";
import { deviceValues } from "./storage";

/*
 * Workout reminders on this iPhone: their settings, kept in the app's
 * database for every account, and the scheduler that keeps the iPhone's
 * pending reminders in step with the plan.
 */

const key = "reminders";
let current: ReminderSettings | undefined;
const listeners = new Set<() => void>();

export const reminderSettings = {
  get(): ReminderSettings {
    current ??= parseReminderSettings(deviceValues.get(key));
    return current;
  },
  set(next: ReminderSettings) {
    deviceValues.set(key, JSON.stringify(next));
    current = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The reminder settings, updated when they change. */
export function useReminderSettings() {
  return useSyncExternalStore(reminderSettings.subscribe, reminderSettings.get);
}

const native = WorkoutReminders;
const center: ReminderCenter | null = native
  ? {
      scheduleReminders: async (reminders) =>
        (await native.schedule(reminders)) === "denied" ? "denied" : "scheduled",
      cancelReminders: () => native.cancel(),
    }
  : null;

/** The one scheduler for this app process. */
export const reminders = new ReminderScheduler(center);

/** Whether notifications are allowed for the app. */
export function reminderPermission(): Promise<"granted" | "denied" | "undetermined"> {
  return native ? native.permission() : Promise.resolve("denied");
}

/** Asks for notification permission when iOS hasn't asked, and resolves whether reminders can show. */
export function requestReminderPermission(): Promise<boolean> {
  return native ? native.requestPermission().catch(() => false) : Promise.resolve(false);
}
