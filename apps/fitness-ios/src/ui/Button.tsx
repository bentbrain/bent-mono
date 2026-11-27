import { ActivityIndicator, Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { haptic } from "./haptics";
import { Symbol } from "./Symbol";
import type { SFSymbol } from "./Symbol";
import { AppText } from "./Text";
import { cn } from "./typography";

type Tone = "primary" | "secondary" | "tinted" | "danger" | "plain";

const surfaces: Record<Tone, string> = {
  primary: "bg-primary",
  secondary: "bg-card border border-border",
  tinted: "bg-primary-soft",
  danger: "bg-danger-soft",
  plain: "bg-transparent",
};
const labels: Record<Tone, "inverse" | "default" | "primary" | "danger"> = {
  primary: "inverse",
  secondary: "default",
  tinted: "primary",
  danger: "danger",
  plain: "primary",
};
const icons: Record<Tone, string> = {
  primary: "accent-primary-foreground",
  secondary: "accent-foreground",
  tinted: "accent-primary",
  danger: "accent-danger-foreground",
  plain: "accent-primary",
};

export type ButtonProps = {
  label: string;
  onPress: () => void;
  tone?: Tone;
  icon?: SFSymbol;
  size?: "default" | "compact";
  disabled?: boolean;
  busy?: boolean;
  fullWidth?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/** A rounded pill button with an optional SF Symbol. */
export function Button({
  label,
  onPress,
  tone = "primary",
  icon,
  size = "default",
  disabled,
  busy,
  fullWidth,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: ButtonProps) {
  const spinner = useCSSVariable(tone === "primary" ? "--color-primary-foreground" : "--color-primary");
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={() => {
        haptic("selection");
        onPress();
      }}
      className={cn(
        "flex-row items-center justify-center gap-2 rounded-full active:opacity-70",
        size === "compact" ? "min-h-9 px-4" : "min-h-12 px-6",
        fullWidth && "self-stretch",
        surfaces[tone],
        disabled && "opacity-40",
      )}
    >
      {busy ? (
        <ActivityIndicator color={typeof spinner === "string" ? spinner : undefined} />
      ) : (
        <View className="flex-row items-center gap-2">
          {icon ? <Symbol name={icon} size={size === "compact" ? 15 : 17} weight="semibold" tintColorClassName={icons[tone]} /> : null}
          <AppText textRole={size === "compact" ? "footnote" : "body"} weight="semibold" tone={labels[tone]}>
            {label}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

/** A round icon-only button, such as a header or stepper control. */
export function IconButton({
  icon,
  label,
  onPress,
  tone = "tinted",
  size = 40,
  disabled,
  testID,
}: {
  icon: SFSymbol;
  label: string;
  onPress: () => void;
  tone?: Tone;
  size?: number;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        haptic("selection");
        onPress();
      }}
      style={{ width: size, height: size }}
      className={cn("items-center justify-center rounded-full active:opacity-70", surfaces[tone], disabled && "opacity-40")}
    >
      <Symbol name={icon} size={Math.round(size * 0.45)} weight="semibold" tintColorClassName={icons[tone]} />
    </Pressable>
  );
}
