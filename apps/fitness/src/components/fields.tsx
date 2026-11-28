import { Field, FieldLabel, Input, Segments, Select } from "@bent/ui/sdk/field";
import type { ComponentProps } from "react";

/** A labelled text field. Its label names it for screen readers and agents. */
export function TextField({
  label,
  value,
  defaultValue,
  ...props
}: Omit<
  ComponentProps<typeof Input>,
  "id" | "onChange" | "value" | "defaultValue"
> & {
  label: string;
  value?: string | number;
  defaultValue?: string | number;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        {...props}
        value={value === undefined ? undefined : String(value)}
        defaultValue={
          defaultValue === undefined ? undefined : String(defaultValue)
        }
      />
    </Field>
  );
}

/** A labelled list of choices in a popup. */
export function SelectField({
  label,
  ...props
}: ComponentProps<typeof Select> & { label: string }) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select {...props} />
    </Field>
  );
}

/** A labelled row of a few choices, all visible. */
export function ChoiceField({
  label,
  ...props
}: ComponentProps<typeof Segments> & { label: string }) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Segments {...props} />
    </Field>
  );
}
export function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
