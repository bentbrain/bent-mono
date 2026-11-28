import { requireOptionalNativeModule } from "expo";
import type { EventSubscription } from "expo";

/** The Live Activity content, as `activityContent` builds it. Times are milliseconds since 1970. */
type WorkoutActivityContent = {
  workoutId: string;
  workoutName: string;
  startedAt: number;
  state: {
    phase: "lift" | "rest" | "ready" | "hold";
    title: string;
    exercise: string;
    detail: string;
    doneTitle: string;
    doneDetail: string;
    completed: number;
    total: number;
    timerStart: number | null;
    timerEnd: number | null;
    finalEnd: number | null;
  };
  staleAt: number | null;
};

type WorkoutActivityNative = {
  /** Whether Live Activities are on for the app in Settings. */
  isEnabled(): boolean;
  /** Starts the activity for the workout, or updates it. Activities for other workouts end. */
  show(content: WorkoutActivityContent): Promise<void>;
  /** Ends the workout's activity, or every workout activity with null. */
  end(workoutId: string | null): Promise<void>;
  /** The workouts with an activity showing. */
  showing(): string[];
  /** Replaces the pending timer alert. Resolves false when iOS won't show it. */
  scheduleAlert(title: string, body: string, at: number): Promise<boolean>;
  cancelAlert(): void;
};

/** The daily workout reminders. Times are milliseconds since 1970. */
type WorkoutRemindersNative = {
  /** Whether notifications are allowed for the app. */
  permission(): Promise<"granted" | "denied" | "undetermined">;
  /** Asks iOS for notification permission if it hasn't asked, and resolves whether reminders can show. */
  requestPermission(): Promise<boolean>;
  /** Replaces every pending reminder. Resolves "denied" when notifications are off for the app. */
  schedule(reminders: { day: string; at: number; title: string; body: string }[]): Promise<"scheduled" | "denied">;
  /** Removes pending and delivered reminders. */
  cancel(): Promise<void>;
  /** The day of a reminder tapped before JavaScript listened, once. */
  takeOpened(): string | null;
  addListener(event: "onReminderOpened", listener: (event: { day: string }) => void): EventSubscription;
};

/** The native module, or null where it isn't linked, such as in unit tests. */
export const WorkoutActivity = requireOptionalNativeModule<WorkoutActivityNative>("WorkoutActivity");

/** The reminders module, or null where it isn't linked. */
export const WorkoutReminders = requireOptionalNativeModule<WorkoutRemindersNative>("WorkoutReminders");
