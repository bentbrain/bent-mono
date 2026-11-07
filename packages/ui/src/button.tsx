"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { createElement } from "react";
import { cn } from "./utils";

export type ButtonProps = BaseButton.Props & {
  appearance?: "primary" | "outline" | "ghost";
};

/** Shared keyboard, focus, disabled and render composition behavior. */
export function Button({ appearance, className, ...props }: ButtonProps) {
  return createElement(BaseButton, {
    ...props,
    className: appearance
      ? cn("bent-button", `bent-button--${appearance}`, className)
      : className,
  });
}
