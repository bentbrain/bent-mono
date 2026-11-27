import "../global.css";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountProvider, api, session, useAccount, useSession } from "./account/AccountProvider";
import { ApiError } from "./data/api";
import { OfflineError } from "./data/sync-engine";
import { Navigation } from "./navigation/Navigation";
import { Onboarding } from "./screens/settings/Onboarding";
import { SignInScreen } from "./screens/SignInScreen";
import { HealthOutsideAccount } from "./screens/health/HealthOutsideAccount";
import { Button } from "./ui/Button";
import { KeyboardDoneBar } from "./ui/KeyboardDoneBar";
import { Notice } from "./ui/Layout";
import { AppText } from "./ui/Text";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Root />
      <KeyboardDoneBar />
    </SafeAreaProvider>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-screen" accessibilityLabel={label} testID="screen-loading">
      <ActivityIndicator />
    </View>
  );
}

function Root() {
  const state = useSession();
  useEffect(() => {
    void session.restore();
  }, []);
  switch (state.status) {
    case "loading":
      return <Loading label="Opening bent Fitness" />;
    case "signedOut":
      return <SignInScreen message={state.message} />;
    case "signedIn":
      return state.owner ? (
        <AccountProvider key={state.owner} owner={state.owner}>
          <SignedIn />
        </AccountProvider>
      ) : (
        <FindAccount />
      );
  }
}

/**
 * Asks Fitness which account a new sign-in belongs to, so the app can keep
 * that account's data apart on this iPhone.
 */
function FindAccount() {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    const generation = session.generation();
    api
      .loadRecords()
      .then((result) => session.setOwner(result.owner, generation))
      .catch((e: unknown) => {
        if (!active) return;
        setError(
          e instanceof OfflineError
            ? e.message
            : e instanceof ApiError || e instanceof Error
              ? e.message
              : "Fitness could not open your account.",
        );
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  if (!error) return <Loading label="Opening your account" />;
  return (
    <View className="flex-1 justify-center gap-4 bg-screen px-6" testID="screen-account-error">
      <AppText textRole="title" weight="bold">
        Your account didn't open
      </AppText>
      <Notice tone="danger">{error}</Notice>
      <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} />
      <Button label="Sign out" tone="plain" onPress={() => void session.signOut()} />
      <HealthOutsideAccount />
    </View>
  );
}

function SignedIn() {
  const { sync, settings } = useAccount();
  if (!sync.ready) {
    if (sync.error || !sync.online)
      return (
        <View className="flex-1 justify-center gap-4 bg-screen px-6" testID="screen-sync-error">
          <AppText textRole="title" weight="bold">
            Opening your plan
          </AppText>
          <Notice tone={sync.online ? "danger" : "warning"}>
            {sync.error || "Fitness could not be reached. Connect to the internet to load your plan the first time."}
          </Notice>
          <Button label="Try again" onPress={() => void sync.retry()} />
          <HealthOutsideAccount />
        </View>
      );
    return <Loading label="Opening your plan" />;
  }
  // Without saved settings, onboarding sets up the plan. Offline, its save
  // waits in the queue like any other change.
  if (!settings) return sync.loaded || !sync.online ? <Onboarding /> : <Loading label="Opening your plan" />;
  return <Navigation />;
}
