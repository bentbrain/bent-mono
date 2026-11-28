import type { ComponentRef, ReactNode, Ref } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import type { ScrollViewProps } from "react-native";
import { useCSSVariable } from "uniwind";
import { Symbol } from "./Symbol";
import type { SFSymbol } from "./Symbol";
import { AppText } from "./Text";
import { cn, shape } from "./typography";

/**
 * A screen's scrolling content under a native header. Insets follow the
 * header and tab bar automatically.
 */
export type ScrollHandle = ComponentRef<typeof ScrollView>;

export function Screen({
  children,
  testID,
  onRefresh,
  refreshing = false,
  className,
  scrollRef,
  ...props
}: Omit<ScrollViewProps, "refreshControl"> & {
  children: ReactNode;
  testID?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  className?: string;
  /** The scroll view, for screens that scroll to a section. */
  scrollRef?: Ref<ScrollHandle>;
}) {
  const tint = useCSSVariable("--color-primary");
  return (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      className="flex-1 bg-screen"
      contentContainerClassName={cn("gap-6 px-4 pb-10 pt-3", className)}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={typeof tint === "string" ? tint : undefined}
          />
        ) : undefined
      }
      {...props}
    >
      {children}
    </ScrollView>
  );
}

/** A rounded card for content that is not a list. */
export function Card({ children, className, testID }: { children: ReactNode; className?: string; testID?: string }) {
  return (
    <View
      testID={testID}
      className={cn("gap-3 bg-card p-4", className)}
      style={{ borderRadius: shape.card, borderCurve: "continuous" }}
    >
      {children}
    </View>
  );
}

/** A section heading above cards that are not grouped lists. */
export function SectionTitle({ children, trailing }: { children: string; trailing?: ReactNode }) {
  return (
    <View className="flex-row items-end justify-between gap-3 px-1">
      <AppText textRole="headline" weight="bold" accessibilityRole="header">
        {children}
      </AppText>
      {trailing}
    </View>
  );
}

const noticeTones = {
  info: { surface: "bg-primary-soft", icon: "info.circle.fill", tint: "accent-primary" },
  success: { surface: "bg-done-soft", icon: "checkmark.circle.fill", tint: "accent-done" },
  warning: { surface: "bg-missed-soft", icon: "exclamationmark.triangle.fill", tint: "accent-missed" },
  danger: { surface: "bg-danger-soft", icon: "xmark.octagon.fill", tint: "accent-danger-foreground" },
} as const;

/** A short message with an icon, such as an error or a status. */
export function Notice({
  children,
  tone = "info",
  action,
  testID,
}: {
  children: ReactNode;
  tone?: keyof typeof noticeTones;
  action?: ReactNode;
  testID?: string;
}) {
  const style = noticeTones[tone];
  return (
    <View
      className={cn("gap-3 p-3.5", style.surface)}
      style={{ borderRadius: shape.control, borderCurve: "continuous" }}
      accessibilityRole={tone === "danger" ? "alert" : undefined}
    >
      <View className="flex-row gap-2.5">
        <Symbol name={style.icon} size={18} tintColorClassName={style.tint} />
        <AppText textRole="footnote" testID={testID} className="flex-1">
          {children}
        </AppText>
      </View>
      {action}
    </View>
  );
}

/** A centred message for an empty list or a screen with nothing to show yet. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: SFSymbol;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <View className="items-center gap-2 px-6 py-10">
      <Symbol name={icon} size={40} tintColorClassName="accent-chevron" />
      <AppText textRole="headline" weight="semibold" className="text-center">
        {title}
      </AppText>
      {body ? (
        <AppText textRole="footnote" tone="muted" className="text-center">
          {body}
        </AppText>
      ) : null}
      {action ? <View className="mt-2">{action}</View> : null}
    </View>
  );
}

/** A small rounded label, such as a session type or status. */
export function Badge({
  label,
  tone = "default",
  icon,
}: {
  label: string;
  tone?: "default" | "primary" | "done" | "missed";
  icon?: SFSymbol;
}) {
  const surfaces = {
    default: "bg-card-alt",
    primary: "bg-primary-soft",
    done: "bg-done-soft",
    missed: "bg-missed-soft",
  };
  const tints = {
    default: "accent-foreground-muted",
    primary: "accent-primary",
    done: "accent-done",
    missed: "accent-missed",
  };
  return (
    <View className={cn("flex-row items-center gap-1 self-start rounded-full px-2.5 py-1", surfaces[tone])}>
      {icon ? <Symbol name={icon} size={11} weight="semibold" tintColorClassName={tints[tone]} /> : null}
      <AppText textRole="caption" weight="semibold" tone={tone === "default" ? "muted" : tone}>
        {label}
      </AppText>
    </View>
  );
}
