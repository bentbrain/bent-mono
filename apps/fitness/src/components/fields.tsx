import { Field, FieldLabel, Input, Segments } from "@bent/ui/sdk/field";
import type { ComponentProps, ReactNode } from "react";

/** Words that tell repeated controls apart for screen readers and agents, after the visible label. */
export function Hidden({ children }: { children: ReactNode }) {
  return <span className="visually-hidden"> ({children})</span>;
}

type Limits = {
  type?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
};

/** Whether a value suits the field's type, range and step. */
export function fits(value: string, { type, min, max, step }: Limits) {
  if (value === "") return true;
  if (type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return false;
    return (
      (min === undefined || value >= String(min)) &&
      (max === undefined || value <= String(max))
    );
  }
  if (type === "number") {
    const number = Number(value);
    if (value.trim() === "" || !Number.isFinite(number)) return false;
    if (min !== undefined && number < Number(min)) return false;
    if (max !== undefined && number > Number(max)) return false;
    if (step === undefined || step === "any") return true;
    const steps = (number - Number(min ?? 0)) / Number(step);
    return Math.abs(steps - Math.round(steps)) < 1e-9;
  }
  return true;
}

/** A labelled text field. Its label names it for screen readers and agents. */
export function TextField({
  label,
  context,
  id,
  value,
  defaultValue,
  ...props
}: Omit<ComponentProps<typeof Input>, "onChange" | "value" | "defaultValue"> & {
  label: string;
  context?: string;
  value?: string | number;
  defaultValue?: string | number;
}) {
  return (
    <Field>
      {/* An explicit id, which the settings error summary moves focus to, needs the label to follow it. */}
      <FieldLabel {...(id ? { htmlFor: id } : {})}>
        {label}
        {context && <Hidden>{context}</Hidden>}
      </FieldLabel>
      <Input
        {...props}
        {...(id ? { id } : {})}
        onValueChange={(next, details) => {
          // The browser drops a value its input type can't hold, and an agent
          // gets no form validation, so check what an agent sends here.
          if (details.source === "agent" && !fits(next, props)) {
            details.cancel();
            return;
          }
          props.onValueChange?.(next, details);
        }}
        value={value === undefined ? undefined : String(value)}
        defaultValue={
          defaultValue === undefined ? undefined : String(defaultValue)
        }
      />
    </Field>
  );
}

/** A labelled row of a few choices, all visible. */
export function ChoiceField({
  label,
  context,
  ...props
}: ComponentProps<typeof Segments> & { label: string; context?: string }) {
  return (
    <Field>
      <FieldLabel>
        {label}
        {context && <Hidden>{context}</Hidden>}
      </FieldLabel>
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
