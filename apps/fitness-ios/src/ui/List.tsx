import { Children, Fragment, isValidElement } from "react";
import type { ReactNode } from "react";
import { Pressable, Switch, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { haptic } from "./haptics";
import { Symbol } from "./Symbol";
import type { SFSymbol } from "./Symbol";
import { AppText } from "./Text";
import { cn, shape } from "./typography";

/**
 * An inset grouped section, as in iOS Settings: a footnote title, rows on
 * a rounded card separated by hairlines, and an optional footer.
 */
export function ListSection({
  title,
  trailing,
  footer,
  children,
  testID,
}: {
  title?: string;
  trailing?: ReactNode;
  footer?: string;
  children: ReactNode;
  testID?: string;
}) {
  const rows = Children.toArray(children).filter((child) => isValidElement(child));
  return (
    <View className="gap-2" testID={testID}>
      {title || trailing ? (
        <View className="min-h-5 flex-row items-end justify-between gap-3 px-4">
          {title ? (
            <AppText textRole="footnote" weight="medium" tone="muted" accessibilityRole="header" className="uppercase">
              {title}
            </AppText>
          ) : (
            <View />
          )}
          {trailing}
        </View>
      ) : null}
      <View
        className="overflow-hidden bg-grouped-card"
        style={{ borderRadius: shape.group, borderCurve: "continuous" }}
      >
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View className="ml-4 h-px bg-separator" /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? (
        <AppText textRole="footnote" tone="muted" className="px-4">
          {footer}
        </AppText>
      ) : null}
    </View>
  );
}

export type ListRowProps = {
  label: string;
  description?: string;
  detail?: string;
  icon?: SFSymbol;
  /** The icon's tile colour, as a token class such as `bg-primary`. */
  iconTile?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  /** Shows a chevron, for rows that open another screen. */
  navigates?: boolean;
  selected?: boolean;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
  testID?: string;
  accessibilityHint?: string;
};

/** One row in a ListSection: label, description, detail and accessory. */
export function ListRow({
  label,
  description,
  detail,
  icon,
  iconTile,
  leading,
  trailing,
  onPress,
  navigates,
  selected,
  tone = "default",
  disabled,
  testID,
  accessibilityHint,
}: ListRowProps) {
  const content = (
    <View
      className={cn(
        "min-h-12 flex-row items-center gap-3 px-4 py-3",
        description && "min-h-16",
        disabled && "opacity-45",
      )}
    >
      {icon ? (
        iconTile ? (
          <View className={cn("size-8 items-center justify-center rounded-[9px]", iconTile)}>
            <Symbol name={icon} size={17} weight="semibold" tintColorClassName="accent-primary-foreground" />
          </View>
        ) : (
          <View className="size-7 items-center justify-center">
            <Symbol
              name={icon}
              size={20}
              tintColorClassName={
                tone === "danger" ? "accent-danger-foreground" : tone === "primary" ? "accent-primary" : "accent-icon"
              }
            />
          </View>
        )
      ) : (
        leading
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <AppText tone={tone === "default" ? "default" : tone}>{label}</AppText>
        {description ? (
          <AppText textRole="footnote" tone="muted">
            {description}
          </AppText>
        ) : null}
      </View>
      {detail ? (
        <AppText textRole="body" tone="muted" numberOfLines={1} className="max-w-[45%] text-right">
          {detail}
        </AppText>
      ) : null}
      {trailing}
      {selected ? <Symbol name="checkmark" size={16} weight="semibold" tintColorClassName="accent-primary" /> : null}
      {navigates ? (
        <Symbol name="chevron.right" size={13} weight="semibold" tintColorClassName="accent-chevron" />
      ) : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{content}</View>;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[label, detail].filter(Boolean).join(", ")}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(selected) }}
      disabled={disabled}
      onPress={() => {
        haptic("selection");
        onPress();
      }}
      className="active:bg-card-alt"
    >
      {content}
    </Pressable>
  );
}

/** A row with a switch. */
export function ListToggleRow({
  label,
  description,
  value,
  onValueChange,
  disabled,
  testID,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const track = useCSSVariable("--color-primary");
  return (
    <ListRow
      label={label}
      description={description}
      disabled={disabled}
      trailing={
        <Switch
          testID={testID}
          accessibilityLabel={label}
          value={value}
          disabled={disabled}
          onValueChange={(next) => {
            haptic("selection");
            onValueChange(next);
          }}
          trackColor={{ true: typeof track === "string" ? track : undefined, false: undefined }}
        />
      }
    />
  );
}
