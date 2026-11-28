import type { JSX } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, View } from "react-native";
import { formatDate, formatShortDate, trackedNutrients } from "@bent/fitness-contracts/domain";
import { useCSSVariable } from "uniwind";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button, IconButton } from "../../ui/Button";
import { ListRow, ListSection } from "../../ui/List";
import { Card, Notice, Screen, SectionTitle } from "../../ui/Layout";
import { AppText } from "../../ui/Text";
import { SelectableChart, useSelectionColors } from "../../ui/charts";
import { haptic } from "../../ui/haptics";
import { cn } from "../../ui/typography";
import { DateBar } from "../shared/DateBar";
import { dayLabels, daySummary, lastSevenDays, mealFromRegular, mealSummary, mealsOn, regulars, weekDescription } from "./meals";
import { useFoodNavigation } from "./navigation";
import { setFoodNotice, useFoodNotice } from "./notice";

function colour(value: string | number | undefined) {
  return typeof value === "string" ? value : undefined;
}

/** Calories and protein for the chosen day, saved meals and the last seven days. */
export function FoodScreen(): JSX.Element {
  const { sync, settings, date, setDate } = useConfiguredAccount();
  const navigation = useFoodNavigation();
  const notice = useFoodNotice();
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // A new day starts without the previous day's messages.
  const shownDate = useRef(date);
  useEffect(() => {
    if (shownDate.current === date) return;
    shownDate.current = date;
    setFoodNotice("");
    setFailed(false);
  }, [date]);
  useEffect(() => {
    if (notice) AccessibilityInfo.announceForAccessibility(notice);
  }, [notice]);
  // Signing out closes the screen; the next account starts without a message.
  useEffect(() => () => setFoodNotice(""), []);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton tone="plain" icon="plus" label="Add food" onPress={() => navigation.navigate("FoodMeal", { date })} testID="food-add" />
      ),
    });
  }, [navigation, date]);

  const summary = daySummary(sync.records, date, settings);
  const tracked = trackedNutrients(settings);
  const meals = mealsOn(sync.records, date);
  const saved = regulars(sync.records);
  const week = lastSevenDays(sync.records, date, settings.calories);

  function attempt(changed: boolean) {
    setFailed(!changed);
    if (!changed) haptic("error");
    return changed;
  }

  function remove(meal: (typeof meals)[number]) {
    Alert.alert(`Remove ${meal.data.name}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          if (attempt(sync.put(null, meal.id, meal.revision))) haptic("success");
        },
      },
    ]);
  }

  return (
    <Screen
      testID="screen-food"
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void sync.refresh().finally(() => setRefreshing(false));
      }}
    >
      <DateBar step />

      <Card testID="food-totals">
        <AppText textRole="footnote" weight="medium" tone="muted" accessibilityRole="header">
          {`Totals for ${formatDate(date)}`}
        </AppText>
        <View className="flex-row gap-4">
          <Total
            label="Calories"
            value={String(summary.calories.value)}
            target={`of ${summary.calories.target} kcal`}
            progress={summary.calories.progress}
            note={summary.calories.note}
            tone={summary.calories.over ? "missed" : "default"}
            testID="food-calories"
          />
          <Total
            label="Protein"
            value={`${summary.protein.value}g`}
            target={`of ${summary.protein.target}g protein`}
            progress={summary.protein.progress}
            note={summary.protein.note}
            tone={summary.protein.reached ? "done" : "default"}
            testID="food-protein"
          />
        </View>
        {summary.nutrients.length ? <View className="h-px bg-separator" /> : null}
        {summary.nutrients.length ? (
          <View className="flex-row gap-3" testID="food-nutrients">
            {summary.nutrients.map((item) => (
              <Total
                key={item.nutrient}
                compact
                label={item.label}
                value={`${item.value}g`}
                target={item.target === null ? "No target" : `of ${item.target}g`}
                progress={item.progress}
                note={item.note}
                detail={item.coverage}
                tone={item.tone}
                testID={`food-${item.nutrient}`}
              />
            ))}
          </View>
        ) : null}
      </Card>

      {notice ? (
        <Notice tone="success" testID="food-notice">
          {notice}
        </Notice>
      ) : null}
      {failed && sync.error ? (
        <Notice tone="danger" testID="food-sync-error">
          {sync.error}
        </Notice>
      ) : null}

      <View className="gap-3">
        <ListSection title={`Logged on ${formatDate(date)}`} testID="food-meals">
          {meals.length ? (
            meals.map((meal, index) => (
              <ListRow
                key={meal.id}
                label={meal.data.name}
                description={mealSummary(meal.data, tracked)}
                trailing={
                  <View className="flex-row gap-2">
                    <IconButton
                      icon="pencil"
                      size={34}
                      label={`Edit ${meal.data.name}`}
                      onPress={() => navigation.navigate("FoodMeal", { date, mealId: meal.id })}
                      testID={`meal-edit-${index}`}
                    />
                    <IconButton
                      icon="trash"
                      tone="danger"
                      size={34}
                      label={`Remove ${meal.data.name}`}
                      onPress={() => remove(meal)}
                      testID={`meal-remove-${index}`}
                    />
                  </View>
                }
              />
            ))
          ) : (
            <ListRow
              icon="fork.knife"
              label="No food recorded for this date"
              description="Add a meal or choose a saved meal."
            />
          )}
        </ListSection>
        <Button label="Add food" icon="plus" tone="tinted" fullWidth onPress={() => navigation.navigate("FoodMeal", { date })} testID="food-add-meal" />
      </View>

      <ListSection
        title="Saved meals"
        trailing={
          saved.length ? (
            <AppText
              textRole="footnote"
              weight="semibold"
              tone="primary"
              accessibilityRole="button"
              accessibilityLabel="Manage saved meals"
              onPress={() => navigation.navigate("FoodSavedMeals")}
              testID="saved-meals-manage"
            >
              Manage
            </AppText>
          ) : undefined
        }
        footer={saved.length ? `Tap a saved meal to add it to ${formatShortDate(date)}.` : undefined}
        testID="food-saved-meals"
      >
        {saved.length ? (
          saved.map((item, index) => (
            <ListRow
              key={item.id}
              icon="plus.circle.fill"
              tone="primary"
              label={item.data.name}
              description={mealSummary(item.data, tracked)}
              accessibilityHint={`Adds it to ${formatDate(date)}`}
              onPress={() => {
                if (attempt(sync.put(mealFromRegular(item.data, date)))) {
                  setFoodNotice(`Added ${item.data.name} for ${formatDate(date)}.`);
                  haptic("success");
                }
              }}
              testID={`saved-meal-add-${index}`}
            />
          ))
        ) : (
          <ListRow
            icon="bookmark"
            label="No saved meals yet"
            description="Turn on Add to Saved meals when you add food to reuse it here with one tap."
          />
        )}
      </ListSection>

      <WeekChart week={week} target={settings.calories} />

      <ListSection
        title="Calories by day"
        footer={`Bars show calories logged each day. The dashed line is your ${settings.calories} kcal target. Tap a day to show it.`}
        testID="food-week-days"
      >
        {week.days.map((day) => (
          <ListRow
            key={day.day}
            label={formatShortDate(day.day)}
            detail={`${day.calories} kcal`}
            selected={day.selected}
            accessibilityHint="Shows this day"
            onPress={() => setDate(day.day)}
            testID={`food-day-${day.day}`}
          />
        ))}
      </ListSection>
      <Button
        label="Change targets"
        icon="target"
        tone="plain"
        size="compact"
        onPress={() => navigation.navigate("SettingsTab", { screen: "Profile" })}
        testID="food-change-targets"
      />
    </Screen>
  );
}

/**
 * One total against its target. `compact` totals sit three to a row for
 * tracked nutrients; one without a target shows no bar or note.
 */
function Total({
  label,
  value,
  target,
  progress,
  note,
  detail,
  tone,
  compact,
  testID,
}: {
  label: string;
  value: string;
  target: string;
  progress: number | null;
  note: string;
  detail?: string;
  tone: "default" | "done" | "missed";
  compact?: boolean;
  testID: string;
}) {
  const spoken = [`${label}: ${value} ${target}`, note, detail].filter(Boolean).join(". ");
  return (
    <View className={cn("min-w-0 flex-1", compact ? "gap-1" : "gap-1.5")} accessible accessibilityLabel={`${spoken}.`} testID={testID}>
      <AppText textRole="caption" weight="medium" tone="muted" className="uppercase">
        {label}
      </AppText>
      <AppText textRole={compact ? "title" : "display"} weight="bold" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </AppText>
      <AppText textRole={compact ? "caption" : "footnote"} tone="muted">
        {target}
      </AppText>
      {progress === null ? null : (
        <View
          className={cn("overflow-hidden rounded-full bg-card-alt", compact ? "h-1.5" : "h-2")}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
        >
          <View
            className={cn("h-full rounded-full", tone === "missed" ? "bg-missed" : tone === "done" ? "bg-done" : "bg-primary")}
            style={{ width: `${progress * 100}%` }}
          />
        </View>
      )}
      {note ? (
        <AppText textRole={compact ? "caption" : "footnote"} weight="semibold" tone={tone}>
          {note}
        </AppText>
      ) : null}
      {detail ? (
        <AppText textRole="caption" tone="muted">
          {detail}
        </AppText>
      ) : null}
    </View>
  );
}

function WeekChart({ week, target }: { week: ReturnType<typeof lastSevenDays>; target: number }) {
  const bar = colour(useCSSVariable("--color-chart"));
  const chosen = colour(useCSSVariable("--color-primary"));
  const line = colour(useCSSVariable("--color-foreground-muted"));
  const selection = useSelectionColors();
  return (
    <Card testID="food-week">
      <SectionTitle>Last 7 days</SectionTitle>
      <SelectableChart
        height={180}
        label={weekDescription(week.days, target)}
        testID="food-week-chart"
        chart={{
          kind: "bar",
          bars: week.days.map((day) => ({ x: day.label, y: day.calories, color: day.selected ? chosen : bar })),
          target,
          showAxes: true,
          cornerRadius: 5,
          animate: true,
          labels: dayLabels(week.days, target),
          colors: { ...selection, target: line },
        }}
      />
    </Card>
  );
}
