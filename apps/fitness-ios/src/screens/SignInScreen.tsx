import { useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { session, signInConfigured } from "../account/AccountProvider";
import { SignInCancelled } from "../logic/connect";
import { Button } from "../ui/Button";
import { HealthOutsideAccount } from "./health/HealthOutsideAccount";
import { Notice } from "../ui/Layout";
import { Symbol } from "../ui/Symbol";
import type { SFSymbol } from "../ui/Symbol";
import { AppText } from "../ui/Text";

const jobs: { icon: SFSymbol; title: string; body: string }[] = [
  { icon: "calendar", title: "Week", body: "See what's planned each day and start the next session." },
  { icon: "timer", title: "Workouts", body: "Log sets with a rest timer, then review and correct past sessions." },
  { icon: "fork.knife", title: "Food", body: "Daily calories and protein, optional carbs, fat and fibre, and saved meals you add in one tap." },
  { icon: "chart.line.uptrend.xyaxis", title: "Progress", body: "Sessions by week, strength by exercise and your bodyweight trend." },
  { icon: "heart.text.square", title: "Apple Health", body: "Weigh-ins and runs sync from Health in the background." },
];

/** The first screen: what the app does, and sign-in. */
export function SignInScreen({ message }: { message?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await session.signIn();
    } catch (e) {
      if (!(e instanceof SignInCancelled)) setError(e instanceof Error ? e.message : "Sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView className="flex-1 bg-screen" testID="screen-sign-in">
      <ScrollView contentContainerClassName="grow gap-8 px-6 pb-6 pt-12">
        <View className="gap-2">
          <AppText textRole="headline" weight="heavy" tone="primary">
            bent/fitness
          </AppText>
          <AppText textRole="display" weight="heavy" accessibilityRole="header">
            Train, eat and track in one place.
          </AppText>
        </View>
        <View className="gap-5">
          {jobs.map((job) => (
            <View key={job.title} className="flex-row gap-4">
              <View className="size-10 items-center justify-center rounded-xl bg-primary-soft">
                <Symbol name={job.icon} size={20} tintColorClassName="accent-primary" />
              </View>
              <View className="flex-1 gap-0.5">
                <AppText weight="semibold">{job.title}</AppText>
                <AppText textRole="footnote" tone="muted">
                  {job.body}
                </AppText>
              </View>
            </View>
          ))}
        </View>
        <View className="flex-1" />
        <HealthOutsideAccount />
        <View className="gap-3">
          {message ? <Notice tone="warning">{message}</Notice> : null}
          {error ? (
            <Notice tone="danger" testID="sign-in-message">
              {error}
            </Notice>
          ) : null}
          {signInConfigured ? null : (
            <Notice tone="warning" testID="sign-in-unconfigured">
              Sign-in is not set up in this build.
            </Notice>
          )}
          <Button
            label="Sign in to Fitness"
            onPress={() => void signIn()}
            busy={busy}
            disabled={!signInConfigured}
            fullWidth
            testID="sign-in"
          />
          <AppText textRole="footnote" tone="muted" className="text-center">
            Invited accounts only. Your training and nutrition stay private.
          </AppText>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
