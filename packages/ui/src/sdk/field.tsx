"use client";

import type { ComponentProps, ReactNode } from "react";
import {
  Checkbox as SdkCheckbox,
  CheckboxIndicator,
} from "@ui-sdk/react/checkbox";
import {
  Field as SdkField,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@ui-sdk/react/field";
import { Input as SdkInput } from "@ui-sdk/react/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  Select as SdkSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { cn } from "../utils";

export { FieldDescription, FieldError, FieldLabel };

export type Choice = { value: string; label: string; disabled?: boolean };

/** A UI SDK field: its label names the control inside it, for people and agents. */
export function Field({
  className,
  ...props
}: ComponentProps<typeof SdkField> & { className?: string }) {
  return <SdkField {...props} className={cn("bent-field", className)} />;
}

export function Input({
  className,
  ...props
}: ComponentProps<typeof SdkInput> & { className?: string }) {
  return <SdkInput {...props} className={cn("bent-control", className)} />;
}

/** A list of choices in a popup, with the shared control look. */
export function Select({
  items,
  value,
  onValueChange,
  placeholder,
  name,
  disabled,
  required,
  className,
  contentProps,
}: {
  items: Choice[];
  /** Props for the popup list, like privacy attributes for page capture tools. */
  contentProps?: Omit<
    ComponentProps<typeof SelectContent>,
    "children" | "className"
  >;
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
}) {
  return (
    <SdkSelect
      value={value}
      onValueChange={(next) => onValueChange?.(next)}
      placeholder={placeholder}
      name={name}
      disabled={disabled}
      required={required}
    >
      <SelectTrigger
        className={cn("bent-control", "bent-select-trigger", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent {...contentProps} className="bent-select-content">
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className="bent-select-item"
          >
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SdkSelect>
  );
}

/** A compact row of choices, all visible. */
export function Segments({
  items,
  value,
  onValueChange,
  name,
  disabled,
  className,
}: {
  items: Choice[];
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  name?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <SegmentedControl
      value={value}
      onValueChange={(next) => onValueChange?.(next)}
      name={name}
      disabled={disabled}
      className={cn("bent-segments", className)}
    >
      {items.map((item) => (
        <SegmentedControlItem
          key={item.value}
          value={item.value}
          disabled={item.disabled}
          className="bent-segment"
        >
          {item.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/** A checkbox whose field label sits beside it. */
export function Checkbox({
  label,
  checked,
  onCheckedChange,
  name,
  disabled,
  className,
}: {
  label: ReactNode;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  name?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <SdkField className={cn("bent-check", className)}>
      <SdkCheckbox
        checked={checked}
        onCheckedChange={(next) => onCheckedChange?.(next === true)}
        name={name}
        value="on"
        disabled={disabled}
        className="bent-checkbox"
      >
        <CheckboxIndicator className="bent-checkbox-indicator" />
      </SdkCheckbox>
      <FieldLabel>{label}</FieldLabel>
    </SdkField>
  );
}
