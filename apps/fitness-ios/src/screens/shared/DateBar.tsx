import { Pressable, View } from "react-native";
import { addDays, formatDate, formatShortDate } from "@bent/fitness-contracts/domain";
import { useAccount } from "../../account/AccountProvider";
import { IconButton } from "../../ui/Button";
import { DateField } from "../../ui/Form";
import { haptic } from "../../ui/haptics";
import { AppText } from "../../ui/Text";
import { cn, shape } from "../../ui/typography";

/**
 * The day a screen shows, with day steps and a date picker. The Week, Food
 * and Bodyweight screens share the chosen day; new entries use it. On
 * another day, the line under the date returns to today, so the bar keeps
 * its height whichever day is shown.
 */
export function DateBar({ step = false }: { step?: boolean }) {
  const { date, today, setDate } = useAccount();
  const isToday = date === today;
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  return (
    <View
      className={cn("min-h-14 flex-row items-center gap-2 bg-card px-2 py-2")}
      style={{ borderRadius: shape.card, borderCurve: "continuous" }}
      testID="date-bar"
    >
      {step ? (
        <IconButton icon="chevron.left" label={`Previous day, ${formatDate(previous)}`} onPress={() => setDate(previous)} testID="date-previous" />
      ) : null}
      <View className="flex-1 px-2">
        <View
          accessible
          accessibilityLabel={isToday ? `Today, ${formatDate(date)}` : formatDate(date)}
          accessibilityHint={isToday ? undefined : "New entries here use this date."}
        >
          <AppText textRole="headline" weight="bold">
            {isToday ? "Today" : formatShortDate(date)}
          </AppText>
        </View>
        {isToday ? (
          <AppText textRole="footnote" tone="muted" accessibilityElementsHidden importantForAccessibility="no">
            {formatShortDate(date)}
          </AppText>
        ) : (
          <Pressable
            onPress={() => {
              haptic("selection");
              setDate(today);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Back to today, ${formatDate(today)}`}
            hitSlop={8}
            className="self-start active:opacity-70"
            testID="date-today"
          >
            <AppText textRole="footnote" weight="semibold" tone="primary" numberOfLines={1}>
              Back to today
            </AppText>
          </Pressable>
        )}
      </View>
      <DateField label="Choose date" showLabel={false} value={date} onChange={(value) => setDate(value || today)} testID="date-pick" />
      {step ? <IconButton icon="chevron.right" label={`Next day, ${formatDate(next)}`} onPress={() => setDate(next)} testID="date-next" /> : null}
    </View>
  );
}
