import { Field, Input, Select } from "@bent/ui/field";
import type { ComponentProps } from "react";
export function TextField({
  label,
  id,
  ...props
}: ComponentProps<"input"> & { label: string; id: string }) {
  return (
    <Field label={label} htmlFor={id}>
      <Input id={id} {...props} />
    </Field>
  );
}
export function SelectField({
  label,
  id,
  ...props
}: ComponentProps<"select"> & { label: string; id: string }) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} {...props} />
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
