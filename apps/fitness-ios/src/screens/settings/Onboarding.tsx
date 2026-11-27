import { useState } from "react";
import { View } from "react-native";
import { defaultSettings, localDate, settingsId } from "@bent/fitness-contracts/domain";
import { useAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { haptic } from "../../ui/haptics";
import { Card, Notice, Screen } from "../../ui/Layout";
import { Symbol } from "../../ui/Symbol";
import type { SFSymbol } from "../../ui/Symbol";
import { AppText } from "../../ui/Text";
import { planSummary } from "./rules";

/** Sets up the plan for an account without settings. */
export function Onboarding() {
  const { sync } = useAccount();
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const plan = defaultSettings(localDate(timezone), timezone);
  const summary = planSummary(plan);
  const [failed, setFailed] = useState(false);

  const rows: { icon: SFSymbol; label: string; value: string }[] = [
    { icon: "dumbbell.fill", label: "Strength", value: summary.strength },
    { icon: "figure.run", label: "Runs", value: summary.runs },
    { icon: "fork.knife", label: "Food", value: summary.food },
    { icon: "globe", label: "Timezone", value: timezone },
  ];

  return (
    <Screen testID="screen-onboarding" className="pt-8">
      <View className="gap-2">
        <AppText textRole="footnote" weight="semibold" tone="primary" className="uppercase">
          Your first week
        </AppText>
        <AppText textRole="display" weight="bold" accessibilityRole="header">
          Set up your training week
        </AppText>
        <AppText tone="secondary">
          Start with a beginner dumbbell plan. You can change the days, routines and food targets at any time.
        </AppText>
      </View>

      <Card className="gap-4">
        {rows.map((row) => (
          <View key={row.label} className="flex-row items-start gap-3" accessible accessibilityLabel={`${row.label}: ${row.value}`}>
            <View className="size-8 items-center justify-center rounded-[9px] bg-primary-soft">
              <Symbol name={row.icon} size={16} weight="semibold" tintColorClassName="accent-primary" />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <AppText textRole="caption" weight="semibold" tone="muted" className="uppercase">
                {row.label}
              </AppText>
              <AppText weight="medium">{row.value}</AppText>
            </View>
          </View>
        ))}
      </Card>

      <AppText textRole="footnote" tone="secondary">
        {summary.introduction}
      </AppText>

      {failed && sync.error ? <Notice tone="danger">{sync.error}</Notice> : null}

      <Button
        label="Set up my plan"
        icon="checkmark"
        fullWidth
        onPress={() => {
          const saved = sync.put(defaultSettings(localDate(timezone), timezone), settingsId);
          setFailed(!saved);
          haptic(saved ? "success" : "error");
        }}
        testID="set-up-plan"
      />
    </Screen>
  );
}
