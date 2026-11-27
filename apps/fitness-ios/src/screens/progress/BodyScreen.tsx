import { useState } from "react";
import { Alert, View } from "react-native";
import { displayLoad, formatDate, formatShortDate } from "@bent/fitness-contracts/domain";
import type { Settings } from "@bent/fitness-contracts/domain";
import { dailyWeights } from "@bent/fitness-contracts/progress";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { DateField, NumberField } from "../../ui/Form";
import { Card, Notice, Screen } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { haptic } from "../../ui/haptics";
import { DateBar } from "../shared/DateBar";
import { TrendChart } from "./charts";
import { bodyChart, daysBetween, parseWeighIn, replacedWeighIn, roundedWeight, shownWeight, weighInLabels, weighInOn, weightLimits } from "./summary";
import type { Weigh } from "./summary";

export function BodyScreen() {
  const { date } = useConfiguredAccount();
  // A new day starts a fresh form, as the web page does for each date.
  return <Bodyweight key={date} />;
}

function Bodyweight() {
  const { sync, settings, date, setDate } = useConfiguredAccount();
  const units = settings.units;
  const [formDate, setFormDate] = useState(date);
  const [weight, setWeight] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const daily = dailyWeights(sync.records);
  const chart = bodyChart(daily);
  const onDay = weighInOn(sync.records, date);
  const limits = weightLimits(units);

  function save() {
    const result = parseWeighIn(formDate, weight, units);
    if ("error" in result) {
      setError(result.error);
      setSaved("");
      haptic("error");
      return;
    }
    if (sync.put(result.data, replacedWeighIn(sync.records, result.data.date))) {
      haptic("success");
      setSaved(`Saved ${shownWeight(result.data.kg, units)} for ${formatDate(result.data.date)}.`);
      setFormDate(date);
      setWeight("");
      setError("");
    } else {
      haptic("error");
      setError("This weigh-in could not be saved. Check the message above.");
    }
  }
  function remove(weigh: Weigh) {
    haptic("warning");
    Alert.alert("Remove weigh-in?", `Remove weigh-in for ${formatDate(weigh.date)}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          if (sync.put(null, weigh.id)) {
            haptic("success");
            setSaved(`Removed the weigh-in for ${formatDate(weigh.date)}.`);
          }
        },
      },
    ]);
  }
  function edit(weigh: Weigh) {
    setFormDate(weigh.date);
    setWeight(String(displayLoad(weigh.kg, units)));
    setSaved("");
    setError("");
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await sync.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen testID="screen-body" onRefresh={() => void refresh()} refreshing={refreshing}>
      <DateBar step />

      <Card testID="body-chart">
        <AppText textRole="caption" weight="medium" tone="muted" className="uppercase">
          Latest 7 weigh-ins · average
        </AppText>
        <View className="flex-row items-baseline gap-1.5">
          <AppText textRole="display" weight="bold" style={{ fontVariant: ["tabular-nums"] }} testID="body-average">
            {chart.average !== null ? roundedWeight(chart.average, units) : "—"}
          </AppText>
          <AppText tone="muted">{units}</AppText>
        </View>
        {chart.points.length > 0 && chart.lowest !== null && chart.highest !== null ? (
          <BodyChart points={chart.points} trend={chart.trend} lowest={chart.lowest} highest={chart.highest} units={units} />
        ) : (
          <AppText tone="muted">Add your first weigh-in to start the chart.</AppText>
        )}
      </Card>
      {chart.points.length > 0 ? (
        <AppText textRole="footnote" tone="muted" className="px-1">
          Blue line: each weigh-in. Dashed line: average of up to 7 weigh-ins ending on that date. Dotted lines mark your
          highest and lowest weigh-ins in this view.
        </AppText>
      ) : null}

      <ListSection title={`Weigh-in · ${formatShortDate(date)}`}>
        {onDay ? (
          <ListRow
            label={shownWeight(onDay.kg, units)}
            description={formatDate(onDay.date)}
            icon="scalemass"
            trailing={
              <View className="flex-row gap-1">
                <Button label="Edit" tone="tinted" size="compact" accessibilityLabel={`Edit weigh-in ${formatDate(onDay.date)}`} onPress={() => edit(onDay)} />
                <Button label="Remove" tone="plain" size="compact" accessibilityLabel={`Remove weigh-in ${formatDate(onDay.date)}`} onPress={() => remove(onDay)} />
              </View>
            }
            testID="body-day-entry"
          />
        ) : (
          <ListRow label="No weigh-in recorded for this day." testID="body-day-empty" />
        )}
      </ListSection>

      <Card testID="body-form">
        <AppText textRole="headline" weight="semibold" accessibilityRole="header">
          Record a weigh-in
        </AppText>
        <DateField label="Date" value={formDate} onChange={setFormDate} testID="body-form-date" />
        <NumberField
          label={`Weight · ${units}`}
          unit={units}
          value={weight}
          onChangeText={(text) => {
            setWeight(text);
            setError("");
          }}
          hint={`From ${limits.min} to ${limits.max} ${units}. A new weigh-in replaces the one saved for that date.`}
          error={error || null}
          testID="body-weight"
        />
        <Button label="Save weigh-in" icon="checkmark" onPress={save} fullWidth testID="body-save" />
        {saved ? (
          <Notice tone="success" testID="body-saved">
            {saved}
          </Notice>
        ) : null}
      </Card>

      <ListSection
        title="All weigh-ins"
        trailing={
          daily.length ? (
            <AppText
              textRole="footnote"
              weight="semibold"
              tone="primary"
              accessibilityRole="button"
              accessibilityState={{ expanded: showAll }}
              onPress={() => {
                haptic("selection");
                setShowAll((value) => !value);
              }}
              testID="body-toggle-all"
            >
              {showAll ? "Hide" : `Show ${daily.length}`}
            </AppText>
          ) : undefined
        }
      >
        {!daily.length ? <ListRow label="Your weigh-ins will appear here." /> : null}
        {showAll
          ? [...daily].reverse().map((weigh) => (
              <ListRow
                key={weigh.id}
                label={formatDate(weigh.date)}
                selected={weigh.date === date}
                onPress={() => setDate(weigh.date)}
                accessibilityHint="Shows this day"
                trailing={
                  <View className="flex-row items-center gap-1">
                    <AppText weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                      {displayLoad(weigh.kg, units)} {units}
                    </AppText>
                    <Button
                      label="Remove"
                      tone="plain"
                      size="compact"
                      accessibilityLabel={`Remove weigh-in ${formatDate(weigh.date)}`}
                      onPress={() => remove(weigh)}
                    />
                  </View>
                }
              />
            ))
          : null}
      </ListSection>

      <AppText textRole="footnote" tone="muted" className="px-1">
        Compare trends over 2–3 weeks under similar weighing conditions. Carbohydrate changes and starting creatine can
        change water weight. Give those changes time to settle before adjusting calories.
      </AppText>
    </Screen>
  );
}

function BodyChart({
  points,
  trend,
  lowest,
  highest,
  units,
}: {
  points: Weigh[];
  trend: { date: string; kg: number }[];
  lowest: number;
  highest: number;
  units: Settings["units"];
}) {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  const x = (day: string) => daysBetween(first.date, day);
  return (
    <View className="gap-2">
      <TrendChart
        height={200}
        pad={0.5}
        testID="body-trend"
        label={`Bodyweight across ${points.length} recorded dates, from ${shownWeight(lowest, units)} to ${shownWeight(highest, units)}. All weigh-ins are listed below.`}
        points={points.map((point) => ({ x: x(point.date), y: point.kg }))}
        average={trend.map((point) => ({ x: x(point.date), y: point.kg }))}
        labels={weighInLabels(
          points,
          units,
          trend.map((point) => point.kg),
        )}
        guides={lowest === highest ? [highest] : [highest, lowest]}
      />
      <View className="flex-row justify-between" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <AppText textRole="caption" tone="muted">
          {formatShortDate(first.date)}
        </AppText>
        <AppText textRole="caption" tone="muted">
          High {shownWeight(highest, units)}
          {lowest === highest ? "" : ` · Low ${shownWeight(lowest, units)}`}
        </AppText>
        <AppText textRole="caption" tone="muted">
          {last.date !== first.date ? formatShortDate(last.date) : ""}
        </AppText>
      </View>
    </View>
  );
}
