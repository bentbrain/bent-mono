import { View } from "react-native";
import type { Settings } from "@bent/fitness-contracts/domain";
import { useAccount } from "../../account/AccountProvider";
import { Card, SectionTitle } from "../../ui/Layout";
import { Symbol } from "../../ui/Symbol";
import { AppText } from "../../ui/Text";
import { cn, shape } from "../../ui/typography";
import { rotationPreview } from "./rules";

const styles = {
  strength: { surface: "bg-primary-soft", tone: "primary", icon: "dumbbell.fill", tint: "accent-primary" },
  run: { surface: "bg-done-soft", tone: "done", icon: "figure.run", tint: "accent-done" },
  rest: { surface: "bg-card-alt", tone: "muted", icon: "moon.zzz.fill", tint: "accent-icon" },
} as const;

/** The next two weeks as the edited repeating week would schedule them. */
export function RotationPreview({ draft }: { draft: Settings }) {
  const { today } = useAccount();
  const weeks = rotationPreview(draft, today);
  if (!weeks) return null;
  return (
    <View className="gap-3" accessibilityLabel="Next two weeks" testID="rotation-preview">
      <SectionTitle>Next two weeks</SectionTitle>
      {weeks.map((week) => (
        <Card key={week.label} className="gap-2">
          <AppText textRole="footnote" weight="semibold" tone="muted" className="uppercase" accessibilityRole="header">
            {week.label}
          </AppText>
          {week.days.map((day) => {
            const style = styles[day.type];
            return (
              <View
                key={day.day}
                className={cn(
                  "flex-row items-center gap-3 px-3 py-2",
                  style.surface,
                  day.day === today && "border border-border-strong",
                )}
                style={{ borderRadius: shape.control, borderCurve: "continuous" }}
                accessible
                accessibilityLabel={`${day.weekday}${day.day === today ? ", today" : ""}: ${day.title}`}
              >
                <AppText textRole="footnote" weight="semibold" tone="secondary" className="w-10">
                  {day.weekday}
                </AppText>
                <Symbol name={style.icon} size={15} tintColorClassName={style.tint} />
                <AppText weight="semibold" tone={style.tone} className="flex-1" numberOfLines={1}>
                  {day.title}
                </AppText>
              </View>
            );
          })}
        </Card>
      ))}
      <AppText textRole="footnote" tone="muted" className="px-1">
        Preview of the unsaved plan. Save to apply it to your week.
      </AppText>
    </View>
  );
}
