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
  required?: boolean;
  maxLength?: number;
  /** Refuses an empty or blank value from an agent. People get the form's own error. */
  keepFilled?: boolean;
};

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;
// A valid floating-point number as HTML defines it: no "+", spaces or hex.
const decimal = /^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/;

/** Whether a value suits the field's type, range, step and whether it's required. */
export function fits(
  value: string,
  { type, min, max, step, required, maxLength, keepFilled }: Limits,
) {
  if (value === "") return !required && !keepFilled;
  if (maxLength !== undefined && value.length > maxLength) return false;
  if (type !== "date" && type !== "number") {
    // A single-line input drops line breaks, so a value with them isn't what it shows.
    if (/[\r\n]/.test(value)) return false;
    if ((required || keepFilled) && value.trim() === "") return false;
  }
  if (type === "date") {
    const parts = isoDate.exec(value);
    if (!parts) return false;
    const [year, month, day] = parts.slice(1).map(Number);
    if (!year || !month || !day) return false;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      return false;
    return (
      (min === undefined || value >= String(min)) &&
      (max === undefined || value <= String(max))
    );
  }
  if (type === "number") {
    if (!decimal.test(value)) return false;
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    if (min !== undefined && number < Number(min)) return false;
    if (max !== undefined && number > Number(max)) return false;
    if (step === "any") return true;
    const base = Number(min ?? 0);
    const size = Number(step ?? 1);
    if (Number.isInteger(base) && Number.isInteger(size))
      return Number.isInteger(number) && (number - base) % size === 0;
    const steps = (number - base) / size;
    return Math.abs(steps - Math.round(steps)) < 1e-9;
  }
  return true;
}

/** A labelled text field. Its label names it for screen readers and agents. */
export function TextField({
  label,
  context,
  keepFilled,
  accepts,
  id,
  value,
  defaultValue,
  ...props
}: Omit<ComponentProps<typeof Input>, "onChange" | "value" | "defaultValue"> & {
  label: string;
  context?: string;
  keepFilled?: boolean;
  /** A further check on an agent's value, like a schema rule. */
  accepts?: (value: string) => boolean;
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
          if (
            details.source === "agent" &&
            (!fits(next, { ...props, keepFilled }) ||
              (next !== "" && accepts && !accepts(next)))
          ) {
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
