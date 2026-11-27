import { DatePicker, Host, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { datePickerStyle, labelsHidden, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { View } from "react-native";
import type { TextInputProps } from "react-native";
import { haptic } from "./haptics";
import { AppText, AppTextInput } from "./Text";
import { cn } from "./typography";

/** A labelled field: label above, control, then an optional hint or error. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <View className={cn("gap-1.5", className)}>
      <AppText textRole="footnote" weight="medium" tone="secondary">
        {label}
      </AppText>
      {children}
      {error ? (
        <AppText textRole="footnote" tone="danger" accessibilityRole="alert">
          {error}
        </AppText>
      ) : hint ? (
        <AppText textRole="footnote" tone="muted">
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

/** A labelled text input. */
export function TextField({
  label,
  hint,
  error,
  className,
  ...props
}: TextInputProps & { label: string; hint?: string; error?: string | null; className?: string }) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      <AppTextInput accessibilityLabel={label} {...props} />
    </Field>
  );
}

/**
 * A labelled decimal input. The text stays as typed; callers parse it when
 * saving, so an unfinished value such as "62." is kept while editing.
 */
export function NumberField({
  label,
  unit,
  hint,
  error,
  value,
  onChangeText,
  integer,
  testID,
  className,
}: {
  label: string;
  unit?: string;
  hint?: string;
  error?: string | null;
  value: string;
  onChangeText: (text: string) => void;
  integer?: boolean;
  testID?: string;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      <View className="flex-row items-center">
        <AppTextInput
          testID={testID}
          accessibilityLabel={unit ? `${label}, ${unit}` : label}
          value={value}
          onChangeText={onChangeText}
          keyboardType={integer ? "number-pad" : "decimal-pad"}
          inputMode={integer ? "numeric" : "decimal"}
          selectTextOnFocus
          className={cn("flex-1", unit && "pr-12")}
          style={{ fontVariant: ["tabular-nums"] }}
        />
        {unit ? (
          <AppText tone="muted" className="absolute right-3.5" pointerEvents="none">
            {unit}
          </AppText>
        ) : null}
      </View>
    </Field>
  );
}

/** A native segmented control. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  testID,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  testID?: string;
}) {
  return (
    <Host matchContents={{ vertical: true }} style={{ width: "100%" }} testID={testID}>
      <Picker
        label={label}
        selection={value}
        onSelectionChange={(next: T) => {
          haptic("selection");
          onChange(next);
        }}
        modifiers={[pickerStyle("segmented")]}
      >
        {options.map((option) => (
          <SwiftText key={option.value} modifiers={[tag(option.value)]}>
            {option.label}
          </SwiftText>
        ))}
      </Picker>
    </Host>
  );
}

/** A compact native date picker for a calendar day (YYYY-MM-DD). */
export function DateField({
  label,
  value,
  onChange,
  maximum,
  showLabel = true,
  testID,
}: {
  label: string;
  value: string;
  onChange: (date: string) => void;
  maximum?: string;
  /** False keeps the label for VoiceOver only, for a picker beside its own heading. */
  showLabel?: boolean;
  testID?: string;
}) {
  const [year, month, day] = value.split("-").map(Number);
  const selection = new Date(year ?? 2000, (month ?? 1) - 1, day ?? 1, 12);
  const range = maximum
    ? { end: new Date(Number(maximum.slice(0, 4)), Number(maximum.slice(5, 7)) - 1, Number(maximum.slice(8, 10)), 23, 59) }
    : undefined;
  return (
    <View className="flex-row items-center justify-between gap-3">
      {showLabel ? <AppText>{label}</AppText> : null}
      <Host matchContents testID={testID}>
        <DatePicker
          title={label}
          selection={selection}
          range={range}
          displayedComponents={["date"]}
          onDateChange={(date: Date) => {
            const text = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            onChange(text);
          }}
          modifiers={[datePickerStyle("compact"), labelsHidden()]}
        />
      </Host>
    </View>
  );
}
