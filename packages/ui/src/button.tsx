"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { createElement } from "react";

export type ButtonProps = BaseButton.Props;

/** Shared keyboard, focus, disabled and render composition behavior. */
export function Button(props: ButtonProps) {
  return createElement(BaseButton, props);
}
