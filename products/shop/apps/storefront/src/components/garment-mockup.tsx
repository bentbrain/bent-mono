import type { ReactNode } from "react";

import { productProjectionMockupPath } from "@/lib/product-projection";
import { cn } from "@/lib/utils";

interface GarmentMockupProps {
  ariaLabel: string;
  children?: ReactNode;
  className?: string;
  color: string;
  preload?: boolean;
  sizes: string;
}

export function GarmentMockup({
  ariaLabel,
  children,
  className,
  color,
  preload = false,
  sizes,
}: GarmentMockupProps) {
  return (
    <div
      className={cn(
        "relative aspect-square w-full overflow-hidden bg-background",
        className,
      )}
      role="img"
      aria-label={ariaLabel}
    >
      <img
        data-fill="true"
        fetchPriority={preload ? "high" : "auto"}
        src={productProjectionMockupPath("staple-tee", color)}
        alt=""
        sizes={sizes}
        className="object-contain"
      />
      {children}
    </div>
  );
}
