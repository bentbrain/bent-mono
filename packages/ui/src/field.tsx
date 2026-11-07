"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "./utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn("bent-control", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn("bent-control", className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="bent-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
