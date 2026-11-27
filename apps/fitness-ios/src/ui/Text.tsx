import { Text as RNText, TextInput as RNTextInput } from "react-native";
import type { TextInputInstance, TextInputProps, TextProps } from "react-native";
import type { Ref } from "react";
import { numberPad } from "./numberPad";
import { cn, textClasses } from "./typography";
import type { TextRole } from "./typography";

export type AppTextProps = TextProps & {
  className?: string;
  textRole?: TextRole;
  /** Medium, semibold or bold weight. */
  weight?: "regular" | "medium" | "semibold" | "bold" | "heavy";
  tone?: "default" | "secondary" | "muted" | "primary" | "done" | "missed" | "danger" | "inverse";
};

const weights = {
  regular: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
  heavy: "font-extrabold",
} as const;
const tones = {
  default: "text-foreground",
  secondary: "text-foreground-secondary",
  muted: "text-foreground-muted",
  primary: "text-primary",
  done: "text-done-foreground",
  missed: "text-missed-foreground",
  danger: "text-danger-foreground",
  inverse: "text-primary-foreground",
} as const;

/** Text in one of the app's roles, coloured by a semantic tone. */
export function AppText({ className, textRole = "body", weight = "regular", tone = "default", ...props }: AppTextProps) {
  return <RNText className={cn(textClasses[textRole], weights[weight], tones[tone], className)} {...props} />;
}

export type AppTextInputProps = Omit<TextInputProps, "placeholderTextColor"> & {
  className?: string;
  ref?: Ref<TextInputInstance>;
};

const numberPads = new Set(["number-pad", "decimal-pad", "numeric"]);

/**
 * A single text field in the app's input style. A field with a number pad
 * shows the Done bar above the keyboard while it has focus.
 */
export function AppTextInput({ className, ref, onFocus, onBlur, ...props }: AppTextInputProps) {
  const pad = numberPads.has(props.keyboardType ?? "") || props.inputMode === "decimal" || props.inputMode === "numeric";
  return (
    <RNTextInput
      ref={ref}
      onFocus={(event) => {
        if (pad) numberPad.focus();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        if (pad) numberPad.blur();
        onBlur?.(event);
      }}
      className={cn(
        "min-h-12 rounded-[14px] border border-input-border bg-input px-3.5 py-3 text-base text-foreground",
        className,
      )}
      placeholderTextColorClassName="accent-placeholder"
      selectionColorClassName="accent-primary"
      cursorColorClassName="accent-primary"
      {...props}
    />
  );
}
