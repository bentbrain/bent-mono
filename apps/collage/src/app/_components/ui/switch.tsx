"use client";

import * as SwitchPrimitives from "@radix-ui/react-switch";
import { Loader } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
    loading?: boolean;
  }
>(({ className, loading, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-black p-[1px] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-lime-400 data-[state=unchecked]:bg-stone-300",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none flex h-4 w-4 items-center justify-center rounded-full border border-black bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    >
      {loading ? (
        <Loader className="size-[0.075rem] animate-spin text-stone-600" />
      ) : (
        props.children
      )}
    </SwitchPrimitives.Thumb>
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
