import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges class names, later utilities winning over earlier ones. */
export function cn(...values: ClassValue[]) {
  return twMerge(clsx(values));
}

/** Text roles and their classes. Keep the sizes aligned with the scale in global.css. */
export const textClasses = {
  micro: "text-3xs",
  caption: "text-2xs",
  label: "text-xs",
  footnote: "text-sm",
  body: "text-base",
  headline: "text-lg",
  title: "text-xl",
  largeTitle: "text-2xl",
  display: "text-3xl",
} as const;

export type TextRole = keyof typeof textClasses;

/** Corner radii shared by grouped sections, cards and sheets. */
export const shape = { group: 22, card: 18, control: 14, pill: 999 } as const;
