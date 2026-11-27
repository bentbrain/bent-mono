import { View } from "react-native";
import { formatShortDate, totals } from "@bent/fitness-contracts/domain";
import { weeklySummary } from "@bent/fitness-contracts/progress";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { ListRow, ListSection } from "../../ui/List";
import { cn } from "../../ui/typography";
import { pips, rotationNote } from "./logic";
import { useWeekNavigation } from "./navigation";

function Pips({ value }: { value: { done: number; planned: number } }) {
  return (
    <View className="flex-row gap-1" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {pips(value).map((on, index) => (
        <View key={index} className={cn("size-2 rounded-full", on ? "bg-done" : "bg-card-alt")} />
      ))}
    </View>
  );
}

/** Sessions done against the plan this week, and the selected day's food. */
export function WeekTotals({ monday }: { monday: string }) {
  const { settings, sync, today, date } = useConfiguredAccount();
  const navigation = useWeekNavigation();
  const summary = weeklySummary(settings, sync.records, monday, 1)[0];
  const strength = summary?.strength ?? { done: 0, planned: 0 };
  const runs = summary?.runs ?? { done: 0, planned: 0 };
  const food = totals(sync.records, date);
  const foodText = `${Math.round(food.calories)} of ${settings.calories} kcal · ${Math.round(food.protein)} of ${settings.protein} g protein`;
  return (
    <ListSection title="This week" footer={rotationNote(settings)} testID="week-totals">
      {[
        { name: "Strength", value: strength, icon: "dumbbell" as const },
        { name: "Runs", value: runs, icon: "figure.run" as const },
      ].map(({ name, value, icon }) => (
        <ListRow
          key={name}
          icon={icon}
          label={name}
          description={`${value.done} of ${value.planned} planned`}
          trailing={<Pips value={value} />}
        />
      ))}
      <ListRow
        icon="fork.knife"
        label={`Food · ${date === today ? "today" : formatShortDate(date)}`}
        description={foodText}
        accessibilityHint={`${foodText}. Opens Food.`}
        navigates
        onPress={() => navigation.navigate("FoodTab", { screen: "Food" })}
        testID="week-food"
      />
      <ListRow
        icon="calendar"
        label="Edit repeating week"
        navigates
        onPress={() => navigation.navigate("Schedule")}
        testID="week-schedule"
      />
    </ListSection>
  );
}
