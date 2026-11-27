import { useLayoutEffect, useState } from "react";
import { View } from "react-native";
import { mondayOf } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Card, Screen } from "../../ui/Layout";
import { AppText } from "../../ui/Text";
import { DateBar } from "../shared/DateBar";
import { DayPanel } from "./DayPanel";
import { useWeekNavigation } from "./navigation";
import { ReorganiseWeek } from "./ReorganiseWeek";
import { WeekBoard } from "./WeekBoard";
import { WeekTotals } from "./WeekTotals";
import { useEndFinishedActivities } from "./workout/useWorkoutActivity";

/** The week planner: the chosen day's session, the week board and its totals. */
export function WeekScreen() {
  const { sync, date, settings } = useConfiguredAccount();
  const navigation = useWeekNavigation();
  const monday = mondayOf(date);
  const [refreshing, setRefreshing] = useState(false);
  // A workout finished or discarded elsewhere ends its Live Activity.
  useEndFinishedActivities(sync.records, sync.loaded);
  useLayoutEffect(() => {
    navigation.setOptions({ title: "Your week" });
  }, [navigation]);
  return (
    <Screen
      testID="screen-week"
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void sync.refresh().finally(() => setRefreshing(false));
      }}
    >
      {settings.goal ? (
        <AppText textRole="footnote" tone="muted" className="-mt-1 px-1" testID="week-goal">
          {settings.goal}
        </AppText>
      ) : null}
      <DateBar />
      <Card>
        <WeekBoard monday={monday} />
        <View className="h-px bg-separator" />
        <ReorganiseWeek key={monday} monday={monday} />
      </Card>
      <DayPanel day={date} />
      <WeekTotals monday={monday} />
    </Screen>
  );
}
