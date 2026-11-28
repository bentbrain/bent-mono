import { nativeApplicationVersion, nativeBuildVersion } from "expo-application";
import Constants from "expo-constants";
import { Image } from "expo-image";
import { openBrowserAsync } from "expo-web-browser";
import { useState } from "react";
import { ActivityIndicator, Alert } from "react-native";
import { session, useConfiguredAccount } from "../../account/AccountProvider";
import { useReminderSettings } from "../../data/reminders";
import { forgetAccount } from "../../data/storage";
import { widget } from "../../data/widget";
import { clockText } from "../../logic/reminders";
import { useTabNavigation } from "../../navigation/hooks";
import { haptic } from "../../ui/haptics";
import { Notice, Screen } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { clearPickerCopies } from "./pickerFiles";
import { signOutMessage } from "./rules";
import { shareJson } from "./share";

const origin = String(Constants.expoConfig?.extra?.fitnessOrigin ?? "https://fitness.bent.build").replace(/\/$/, "");

/** The Settings tab: profile, plan, equipment, reminders, Apple Health, data and the account. */
export function SettingsScreen() {
  const navigation = useTabNavigation<"SettingsTab">();
  const { owner, sync, settings, api } = useConfiguredAccount();
  const reminder = useReminderSettings();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  async function exportAccount() {
    setExporting(true);
    setError("");
    try {
      const text = await api.exportAccount();
      JSON.parse(text);
      await shareJson("fitness-export.json", text, "Export account data and photos");
      haptic("success");
    } catch {
      haptic("error");
      setError("Export did not finish. No file was saved. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }

  async function exportPending() {
    setError("");
    try {
      await shareJson("fitness-pending.json", sync.draftExport(), "Export pending changes");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pending changes could not be exported. Try again.");
    }
  }

  function signOut() {
    haptic("warning");
    // Queued changes and typed workout values both stay only on this iPhone.
    const unsaved = sync.unsaved();
    Alert.alert("Sign out of bent Fitness?", signOutMessage(unsaved), [
      { text: "Cancel", style: "cancel" },
      ...(unsaved > 0 ? [{ text: "Export pending changes", onPress: () => void exportPending() }] : []),
      {
        text: "Sign out",
        style: "destructive" as const,
        onPress: async () => {
          // Stop syncing, then sign out: the session refuses requests and
          // clears the Keychain first, then this account's data on the iPhone
          // is deleted, and only then does the sign-in screen show.
          sync.stop();
          await session.signOut(async () => {
            forgetAccount(owner);
            clearPickerCopies();
            await Promise.all([Image.clearMemoryCache(), Image.clearDiskCache()]);
            // The session cleared the widget when it closed; this waits for that and reports a failure.
            if ((await widget.signOut(session.generation())) === "failed")
              throw new Error("The widget still shows this account.");
          });
        },
      },
    ]);
  }

  const version = [nativeApplicationVersion, nativeBuildVersion ? `(${nativeBuildVersion})` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <Screen testID="screen-settings">
      <ListSection title="Plan">
        <ListRow
          label="Profile and targets"
          description={`${settings.calories} kcal · ${settings.protein} g protein · ${settings.units}`}
          icon="person.fill"
          iconTile="bg-primary"
          navigates
          onPress={() => navigation.navigate("Profile")}
          testID="open-profile"
        />
        <ListRow
          label="Repeating week"
          description="Training days, rotation, sets and rest"
          icon="calendar"
          iconTile="bg-primary"
          navigates
          onPress={() => navigation.navigate("PlanSettings")}
          testID="open-plan-settings"
        />
        <ListRow
          label="Equipment and photos"
          description={`${settings.equipment.length} ${settings.equipment.length === 1 ? "item" : "items"} · ${settings.dumbbellsKg.length} dumbbell sizes`}
          icon="dumbbell.fill"
          iconTile="bg-primary"
          navigates
          onPress={() => navigation.navigate("Equipment")}
          testID="open-equipment"
        />
        <ListRow
          label="Reminders"
          description={
            reminder.enabled
              ? `${reminder.restDays ? "Every day" : "Training days"} at ${clockText(reminder.minutes)}`
              : "Off"
          }
          icon="bell.fill"
          iconTile="bg-primary"
          navigates
          onPress={() => navigation.navigate("Reminders")}
          testID="open-reminders"
        />
      </ListSection>

      <ListSection title="Apple Health">
        <ListRow
          label="Apple Health"
          description="Weigh-ins and runs from Apple Health"
          icon="heart.fill"
          iconTile="bg-missed"
          navigates
          onPress={() => navigation.navigate("HealthSync")}
          testID="open-health"
        />
      </ListSection>

      <ListSection title="Data" footer="Finish syncing before exporting. Store your export privately.">
        {sync.pending > 0 ? (
          <ListRow label="Finish syncing to export your account." icon="clock" testID="export-waiting" />
        ) : (
          <ListRow
            label={exporting ? "Preparing complete export…" : "Export account data and photos"}
            icon="square.and.arrow.up"
            tone="primary"
            disabled={exporting}
            trailing={exporting ? <ActivityIndicator /> : undefined}
            onPress={() => void exportAccount()}
            testID="export-account"
          />
        )}
        {sync.unsaved() > 0 || sync.conflict || sync.error ? (
          <ListRow
            label="Export pending changes"
            description="The changes on this iPhone that Fitness has not saved"
            icon="tray.and.arrow.up"
            tone="primary"
            onPress={() => void exportPending()}
            testID="export-pending"
          />
        ) : null}
      </ListSection>
      {error ? (
        <Notice tone="danger" testID="data-error">
          {error}
        </Notice>
      ) : null}

      <ListSection
        title="Account"
        footer="Signing out keeps Apple Health sync connected until you disconnect it under Apple Health."
      >
        <ListRow
          label="Manage account"
          description="Profile, email and security"
          icon="person.crop.circle"
          tone="primary"
          onPress={() => void openBrowserAsync(`${origin}/account`)}
          testID="manage-account"
        />
        <ListRow
          label="Sign out"
          icon="rectangle.portrait.and.arrow.right"
          tone="danger"
          onPress={signOut}
          testID="sign-out"
        />
      </ListSection>

      <AppText textRole="footnote" tone="muted" className="text-center" testID="app-version">
        bent Fitness{version ? ` ${version}` : ""}
      </AppText>
    </Screen>
  );
}
