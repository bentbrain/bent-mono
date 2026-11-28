import { useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { addDays, formatShortDate } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { reminderPermission, reminderSettings, requestReminderPermission, useReminderSettings } from "../../data/reminders";
import { fireTimeText, reminderPlan } from "../../logic/reminders";
import { Button } from "../../ui/Button";
import { TimeField } from "../../ui/Form";
import { haptic } from "../../ui/haptics";
import { Notice, Screen } from "../../ui/Layout";
import { ListRow, ListSection, ListToggleRow } from "../../ui/List";

type Permission = "granted" | "denied" | "undetermined";

/** Notification permission, read again each time the app comes forward from Settings. */
function usePermission() {
  const [permission, setPermission] = useState<Permission | null>(null);
  useEffect(() => {
    const read = () => void reminderPermission().then(setPermission, () => setPermission("denied"));
    read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => subscription.remove();
  }, []);
  return { permission, setPermission };
}

/** The time now, moved on when `until` passes and when the app comes forward. */
function useNow(until: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (until === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [until]);
  return now;
}

/** Daily workout reminders on this iPhone: on or off, the time and rest days. */
export function RemindersScreen() {
  const { settings, sync, today } = useConfiguredAccount();
  const preferences = useReminderSettings();
  const { permission, setPermission } = usePermission();
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState<number | undefined>(undefined);
  const now = useNow(until);
  const next = reminderPlan(settings, sync.records, preferences, now)[0];
  useEffect(() => setUntil(next?.at), [next?.at]);
  // The switch shows the setting kept on this iPhone, so it can always be turned off.
  const blocked = permission === "denied" && preferences.enabled;
  const refused = permission === "denied" && asked && !preferences.enabled;

  async function toggle(enabled: boolean) {
    if (!enabled) {
      reminderSettings.set({ ...preferences, enabled: false });
      return;
    }
    setBusy(true);
    const granted = await requestReminderPermission();
    setBusy(false);
    setAsked(true);
    setPermission(granted ? "granted" : "denied");
    if (granted) reminderSettings.set({ ...preferences, enabled: true });
    else haptic("warning");
  }

  const dayLabel = (day: string) =>
    day === today ? "Today" : day === addDays(today, 1) ? "Tomorrow" : formatShortDate(day);

  return (
    <Screen testID="screen-reminders">
      <ListSection footer="Each day's reminder says what's planned, such as the routine, how many exercises and about how long it takes. Reminder settings stay on this iPhone.">
        <ListToggleRow
          label="Workout reminders"
          value={preferences.enabled}
          disabled={busy}
          onValueChange={(value) => void toggle(value)}
          testID="reminders-enabled"
        />
      </ListSection>

      {blocked || refused ? (
        <>
          <Notice tone="warning" testID="reminders-denied">
            {blocked
              ? "Notifications are off for bent Fitness, so reminders can't show. Open Settings, choose Notifications and turn on Allow Notifications."
              : "Notifications are off for bent Fitness. To get reminders, open Settings, choose Notifications and turn on Allow Notifications, then come back and turn on Workout reminders."}
          </Notice>
          <Button
            label="Open Settings"
            tone="secondary"
            icon="gear"
            onPress={() => void Linking.openSettings()}
            testID="reminders-open-settings"
          />
        </>
      ) : null}

      {preferences.enabled ? (
        <>
          <ListSection footer={`Reminders follow your account timezone, ${settings.timezone}.`}>
            <ListRow
              label="Time"
              trailing={
                <TimeField
                  label="Reminder time"
                  minutes={preferences.minutes}
                  onChange={(minutes) => reminderSettings.set({ ...preferences, minutes })}
                  testID="reminders-time"
                />
              }
            />
            <ListToggleRow
              label="Rest days"
              description="A reminder on rest days, with your next session"
              value={preferences.restDays}
              onValueChange={(restDays) => reminderSettings.set({ ...preferences, restDays })}
              testID="reminders-rest-days"
            />
          </ListSection>

          <ListSection title="Next reminder">
            {next ? (
              <ListRow
                label={`${next.title} · ${next.body}`}
                description={`${dayLabel(next.day)} at ${fireTimeText(next.at, settings.timezone)}`}
                icon="bell.fill"
                iconTile="bg-primary"
                testID="reminders-next"
              />
            ) : (
              <ListRow
                label="No reminders in the next two weeks"
                description="Days with a recorded session, and rest days when their reminders are off, have none."
                icon="bell.slash"
                testID="reminders-next"
              />
            )}
          </ListSection>
        </>
      ) : null}
    </Screen>
  );
}
