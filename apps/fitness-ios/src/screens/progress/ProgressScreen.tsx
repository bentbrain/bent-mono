import { useTabNavigation } from "../../navigation/hooks";
import { useState } from "react";
import { View } from "react-native";
import { formatDate, formatShortDate, mondayOf } from "@bent/fitness-contracts/domain";
import type { Settings } from "@bent/fitness-contracts/domain";
import { dailyWeights, strengthSeries, weeklySummary, weightTrend } from "@bent/fitness-contracts/progress";
import type { StrengthSeries } from "@bent/fitness-contracts/progress";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Badge, Card, EmptyState, Screen, SectionTitle } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { LegendSwatch, TrendChart, WeekBarsChart } from "./charts";
import {
  countSpoken,
  countText,
  pointText,
  recentSessions,
  sessionDetail,
  sessionName,
  shownWeeks,
  shownWeight,
  strengthLabels,
  strengthSummary,
  trendText,
  weekBarLabels,
  weekBars,
  weekLabel,
  weighInLabels,
} from "./summary";

function StrengthCard({ series, units }: { series: StrengthSeries; units: Settings["units"] }) {
  const summary = strengthSummary(series, units);
  if (!summary) return null;
  const { first, latest } = summary;
  const spread = Math.max(...summary.values) - Math.min(...summary.values);
  return (
    <Card testID={`progress-strength-${series.key}`}>
      <View className="flex-row items-start justify-between gap-3">
        <AppText textRole="headline" weight="semibold" accessibilityRole="header" className="flex-1">
          {series.name}
        </AppText>
        <Badge label={summary.chip} />
      </View>
      {series.points.length > 1 ? (
        <>
          <AppText tone="secondary">
            <AppText weight="bold">{summary.change}</AppText> since {formatShortDate(first.date)}
          </AppText>
          <TrendChart
            height={72}
            pad={spread * 0.2 || 1}
            label={summary.spoken}
            points={summary.values.map((y, x) => ({ x, y }))}
            labels={strengthLabels(series, units)}
            testID={`progress-strength-chart-${series.key}`}
          />
          <View className="flex-row gap-4">
            <View className="flex-1 gap-0.5">
              <AppText textRole="caption" weight="medium" tone="muted">
                First · {formatShortDate(first.date)}
              </AppText>
              <AppText weight="semibold">{pointText(first, series, units)}</AppText>
            </View>
            <View className="flex-1 gap-0.5">
              <AppText textRole="caption" weight="medium" tone="muted">
                Latest · {formatShortDate(latest.date)}
              </AppText>
              <AppText weight="semibold">{pointText(latest, series, units)}</AppText>
            </View>
          </View>
          <AppText textRole="footnote" tone="muted">
            {summary.measure}
          </AppText>
        </>
      ) : (
        <AppText textRole="footnote" tone="muted">
          One session so far: {pointText(latest, series, units)} on {formatShortDate(latest.date)}. The trend starts after
          your next session.
        </AppText>
      )}
    </Card>
  );
}

export function ProgressScreen() {
  const navigation = useTabNavigation<"ProgressTab">();
  const { sync, settings, today, setDate } = useConfiguredAccount();
  const [refreshing, setRefreshing] = useState(false);
  const units = settings.units;
  const weeks = shownWeeks(weeklySummary(settings, sync.records, today, 8), settings.startDate);
  const series = strengthSeries(sync.records);
  const daily = dailyWeights(sync.records);
  const trend = weightTrend(daily);
  const recent = recentSessions(sync.records, 5);
  const recentWeights = daily.slice(-30);
  const weightSpread = recentWeights.length
    ? Math.max(...recentWeights.map((w) => w.kg)) - Math.min(...recentWeights.map((w) => w.kg))
    : 0;
  const thisWeek = mondayOf(today);

  async function refresh() {
    setRefreshing(true);
    try {
      await sync.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen testID="screen-progress" onRefresh={() => void refresh()} refreshing={refreshing}>
      <AppText textRole="footnote" tone="muted" className="px-1">
        Measured from your records
      </AppText>

      <ListSection>
        <ListRow
          label="Sessions"
          description="Workout and run history, corrections"
          icon="list.bullet.rectangle"
          iconTile="bg-primary"
          navigates
          onPress={() => navigation.navigate("History")}
          testID="progress-open-history"
        />
        <ListRow
          label="Bodyweight"
          description="Weigh-ins and your 7-day average"
          icon="scalemass"
          iconTile="bg-done"
          navigates
          onPress={() => navigation.navigate("Body")}
          testID="progress-open-body"
        />
      </ListSection>

      <View className="gap-3">
        <SectionTitle>Sessions by week</SectionTitle>
        {weeks.length ? (
          <>
            <Card>
              <WeekBarsChart
                height={168}
                bars={weekBars(weeks)}
                labels={weekBarLabels(weeks)}
                label={`Sessions in the last ${weeks.length} week${weeks.length === 1 ? "" : "s"}. Each week is listed below.`}
              />
              <View className="flex-row flex-wrap gap-x-4 gap-y-1" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {(
                  [
                    ["strength", "Strength done"],
                    ["runs", "Runs done"],
                    ["open", "Planned, not recorded"],
                  ] as const
                ).map(([part, text]) => (
                  <View key={part} className="flex-row items-center gap-1.5">
                    <LegendSwatch part={part} />
                    <AppText textRole="caption" tone="muted">
                      {text}
                    </AppText>
                  </View>
                ))}
              </View>
            </Card>
            <ListSection
              footer="Bars show completed sessions and planned sessions not recorded. Weeks before your plan start show completed sessions only. Removed workouts do not count."
              testID="progress-weeks"
            >
              {[...weeks].reverse().map((week) => (
                <View
                  key={week.monday}
                  className="min-h-12 flex-row items-center gap-3 px-4 py-3"
                  accessible
                  accessibilityLabel={`Week of ${formatDate(week.monday)}${week.monday === thisWeek ? ", this week" : ""}: ${countSpoken(week.strength, "strength session")}, ${countSpoken(week.runs, "run")}`}
                >
                  <View className="flex-1">
                    <AppText>Week of {weekLabel(week.monday)}</AppText>
                    {week.monday === thisWeek ? (
                      <AppText textRole="footnote" tone="primary">
                        This week
                      </AppText>
                    ) : null}
                  </View>
                  <View className="w-20 items-end">
                    <AppText textRole="caption" tone="muted">
                      Strength
                    </AppText>
                    <AppText weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                      {countText(week.strength)}
                    </AppText>
                  </View>
                  <View className="w-20 items-end">
                    <AppText textRole="caption" tone="muted">
                      Runs
                    </AppText>
                    <AppText weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                      {countText(week.runs)}
                    </AppText>
                  </View>
                </View>
              ))}
            </ListSection>
          </>
        ) : (
          <Card>
            <AppText tone="muted">Weeks appear here from your plan start date.</AppText>
          </Card>
        )}
      </View>

      <View className="gap-3">
        <SectionTitle>Bodyweight</SectionTitle>
        <Card testID="progress-bodyweight">
          {trend.average !== null ? (
            <>
              <View className="gap-0.5">
                <AppText textRole="display" weight="bold" style={{ fontVariant: ["tabular-nums"] }} testID="progress-weight-average">
                  {shownWeight(trend.average, units)}
                </AppText>
                <AppText textRole="footnote" tone="muted">
                  average of the latest {trend.count} weigh-in{trend.count === 1 ? "" : "s"}
                </AppText>
              </View>
              <AppText tone="secondary">{trendText(trend, units)}</AppText>
              {daily.length > 1 ? (
                <TrendChart
                  height={72}
                  pad={weightSpread * 0.2 || 0.5}
                  label={`Bodyweight across ${recentWeights.length} recorded dates, from ${shownWeight(recentWeights[0]?.kg ?? 0, units)} to ${shownWeight(recentWeights.at(-1)?.kg ?? 0, units)}.`}
                  points={recentWeights.map((point, x) => ({ x, y: point.kg }))}
                  labels={weighInLabels(recentWeights, units)}
                  testID="progress-weight-chart"
                />
              ) : null}
            </>
          ) : (
            <AppText tone="muted">No weigh-ins yet. Record one to start your trend.</AppText>
          )}
        </Card>
        <ListSection>
          <ListRow
            label="Bodyweight details and weigh-ins"
            icon="scalemass"
            tone="primary"
            navigates
            onPress={() => navigation.navigate("Body")}
            testID="progress-body-details"
          />
        </ListSection>
      </View>

      <View className="gap-3">
        <SectionTitle>Strength by exercise</SectionTitle>
        {series.length ? (
          series.map((item) => <StrengthCard key={item.key} series={item} units={units} />)
        ) : (
          <Card>
            <EmptyState
              icon="dumbbell"
              title="No completed workouts yet"
              body="Finish a workout to start tracking each exercise. Each card compares your first and latest completed sets."
            />
          </Card>
        )}
      </View>

      <View className="gap-3">
        <ListSection title="Recent sessions" testID="progress-recent">
          {recent.length ? (
            recent.map((session) => (
              <ListRow
                key={session.id}
                label={sessionName(session)}
                description={`${formatShortDate(session.data.date)} · ${sessionDetail(session)}`}
                icon={session.data.kind === "run" ? "figure.run" : "dumbbell"}
                navigates
                accessibilityHint="Opens this day in History"
                onPress={() => {
                  setDate(session.data.date);
                  navigation.navigate("History");
                }}
              />
            ))
          ) : (
            <ListRow label="Your completed workouts and runs will appear here." />
          )}
          <ListRow
            label="All sessions"
            tone="primary"
            navigates
            onPress={() => navigation.navigate("History")}
            testID="progress-all-sessions"
          />
        </ListSection>
      </View>

      <AppText textRole="footnote" tone="muted" className="px-1">
        Weeks run Monday to Sunday. Today is {formatDate(today)}.
      </AppText>
    </Screen>
  );
}
