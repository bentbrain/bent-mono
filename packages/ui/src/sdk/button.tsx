"use client";

import { Button as SdkButton, type ButtonState } from "@ui-sdk/react/button";
import type { ComponentProps } from "react";
import { cn } from "../utils";

export type ButtonProps = ComponentProps<typeof SdkButton> & {
  appearance?: "primary" | "outline" | "ghost";
};

/**
 * A UI SDK button with the shared bent.build appearances. Agents reach it
 * through the UI SDK agent bridge, by its accessible name.
 */
export function Button({ appearance, className, ...props }: ButtonProps) {
  const base = appearance && ["bent-button", `bent-button--${appearance}`];
  return (
    <SdkButton
      {...props}
      className={
        typeof className === "function"
          ? (state: ButtonState) => cn(base, className(state)) || undefined
          : cn(base, className) || undefined
      }
    />
  );
}
