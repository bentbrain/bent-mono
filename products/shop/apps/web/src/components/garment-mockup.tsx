import Image from "next/image";
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
      <Image
        fill
        preload={preload}
        src={productProjectionMockupPath("staple-tee", color)}
        alt=""
        sizes={sizes}
        className="object-contain"
      />
      {children}
    </div>
  );
}
