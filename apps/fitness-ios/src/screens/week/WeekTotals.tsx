import { View } from "react-native";
import { formatShortDate, totals } from "@bent/fitness-contracts/domain";
import { weeklySummary } from "@bent/fitness-contracts/progress";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { ListRow, ListSection } from "../../ui/List";
import { Symbol } from "../../ui/Symbol";
import { planProgress, rotationNote } from "./logic";
import { useWeekNavigation } from "./navigation";
import { Meter } from "./parts";

/** A check once the week's plan is met, otherwise a bar of the sessions done. */
function PlanProgress({ value }: { value: { done: number; planned: number } }) {
  const progress = planProgress(value);
  if (!progress) return null;
  return (
    <View className="w-14 items-end" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {progress.met ? (
        <Symbol name="checkmark.circle.fill" size={22} tintColorClassName="accent-done" />
      ) : (
        <View className="w-full">
          <Meter fraction={progress.fraction} fill="bg-done" />
        </View>
      )}
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
          trailing={<PlanProgress value={value} />}
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
