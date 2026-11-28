import { Pressable, View } from "react-native";
import { addDays, completedActivity, formatDate, formatShortDate } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { IconButton } from "../../ui/Button";
import { haptic } from "../../ui/haptics";
import { Symbol } from "../../ui/Symbol";
import { AppText } from "../../ui/Text";
import { cn, shape } from "../../ui/typography";
import type { DayState } from "./logic";
import { weekDays } from "@bent/fitness-contracts/week";
import { boardLabel, dayInfo } from "./logic";

const surfaces: Record<DayState, string> = {
  done: "bg-done-soft",
  missed: "bg-missed-soft",
  planned: "bg-card-alt",
  rest: "bg-transparent",
};

/** The round marker under each day: a tick, a dash, a ring or a dot. */
function StateMark({ state, size = 18 }: { state: DayState; size?: number }) {
  if (state === "rest")
    return <View className="size-1.5 rounded-full bg-border-strong" style={{ marginVertical: (size - 6) / 2 }} />;
  return (
    <View
      className={cn(
        "items-center justify-center rounded-full",
        state === "done" && "bg-done",
        state === "missed" && "bg-missed",
        state === "planned" && "border-2 border-primary bg-card",
      )}
      style={{ width: size, height: size }}
    >
      {state === "done" ? (
        <Symbol name="checkmark" size={size * 0.55} weight="bold" tintColorClassName="accent-primary-foreground" />
      ) : state === "missed" ? (
        <Symbol name="minus" size={size * 0.55} weight="bold" tintColorClassName="accent-primary-foreground" />
      ) : null}
    </View>
  );
}

/** The training week: seven day cells with their plan and what was recorded. */
export function WeekBoard({ monday }: { monday: string }) {
  const { settings, sync, today, date, setDate } = useConfiguredAccount();
  const activity = completedActivity(sync.records);
  return (
    <View className="gap-3" accessibilityLabel="Training week">
      <View className="flex-row items-center justify-between gap-2">
        <IconButton
          icon="chevron.left"
          label="Previous week"
          size={34}
          onPress={() => setDate(addDays(date, -7))}
          testID="week-previous"
        />
        <AppText textRole="footnote" weight="semibold" tone="secondary" accessibilityRole="header">
          {formatShortDate(monday)} – {formatShortDate(addDays(monday, 6))}
        </AppText>
        <IconButton
          icon="chevron.right"
          label="Next week"
          size={34}
          onPress={() => setDate(addDays(date, 7))}
          testID="week-next"
        />
      </View>
      <View className="flex-row gap-1">
        {weekDays(monday).map((day) => {
          const info = dayInfo(settings, activity, day, today);
          const [kind, detail] = boardLabel(info.plan.type, info.name);
          const weekday = formatShortDate(day).split(" ")[0];
          const isToday = day === today;
          const selected = day === date;
          return (
            <Pressable
              key={day}
              testID={`week-day-${day}`}
              accessibilityRole="button"
              accessibilityLabel={`${formatDate(day)}${isToday ? ", today" : ""}: ${info.name}, ${info.status}`}
              accessibilityState={{ selected }}
              onPress={() => {
                if (selected) return;
                haptic("selection");
                setDate(day);
              }}
              className={cn(
                "min-h-28 min-w-0 flex-1 items-center gap-1 border-[1.5px] border-transparent px-0.5 pb-2.5 pt-2 active:opacity-70",
                surfaces[info.state],
                selected && "border-primary bg-card",
              )}
              style={{ borderRadius: shape.control, borderCurve: "continuous" }}
            >
              <AppText textRole="micro" weight="semibold" tone={isToday ? "primary" : "muted"} className="uppercase">
                {weekday}
              </AppText>
              <View className={cn("size-7 items-center justify-center rounded-full", isToday && "bg-primary")}>
                <AppText
                  textRole="body"
                  weight="bold"
                  tone={isToday ? "inverse" : "default"}
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {Number(day.slice(8))}
                </AppText>
              </View>
              <View className="items-center">
                <AppText
                  textRole="micro"
                  weight="medium"
                  tone={info.state === "rest" ? "muted" : "secondary"}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                >
                  {kind}
                </AppText>
                {detail ? (
                  <AppText textRole="label" weight="bold" numberOfLines={1}>
                    {detail}
                  </AppText>
                ) : null}
              </View>
              <View className="mt-auto">
                <StateMark state={info.state} />
              </View>
            </Pressable>
          );
        })}
      </View>
      <View
        className="flex-row flex-wrap gap-x-3.5 gap-y-1.5"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {(
          [
            ["done", "Done"],
            ["planned", "Planned"],
            ["missed", "Not recorded"],
            ["rest", "Rest"],
          ] as const
        ).map(([state, label]) => (
          <View key={state} className="flex-row items-center gap-1.5">
            <StateMark state={state} size={12} />
            <AppText textRole="caption" tone="muted">
              {label}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  );
}
