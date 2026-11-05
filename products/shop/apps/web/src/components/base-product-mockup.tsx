import Image from "next/image";
import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import type { ReactNode } from "react";

import { productProjectionMockupPath } from "@/lib/product-projection";
import { cn } from "@/lib/utils";

export function BaseProductMockup({
  ariaLabel,
  baseProductSlug,
  children,
  className,
  color,
  preload = true,
  sizes = "(max-width: 900px) 100vw, 54vw",
}: {
  ariaLabel?: string;
  baseProductSlug: BaseProductSlug;
  children?: ReactNode;
  className?: string;
  color: string;
  preload?: boolean;
  sizes?: string;
}) {
  return (
    <div
      className={cn(
        "relative aspect-square size-full overflow-hidden border border-primary bg-white",
        className,
      )}
      role="img"
      aria-label={ariaLabel ??
        `${color} ${baseProductSlug === "staple-tee" ? "AS Colour Staple Tee" : "AS Colour Cotton Tote"}`}
    >
      <Image
        fill
        preload={preload}
        src={productProjectionMockupPath(baseProductSlug, color)}
        alt=""
        sizes={sizes}
        className="object-contain"
      />
      {children}
    </div>
  );
}
