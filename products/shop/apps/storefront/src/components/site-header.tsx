import type { ReactNode } from "react";

import { CartLink } from "@/components/cart-link";
import { createPath, productPath } from "@/lib/products";

export function SiteHeader({ cart = <CartLink /> }: { cart?: ReactNode }) {
  return (
    <header className="sticky top-0 z-[100] -mb-12 grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-primary bg-background px-[clamp(1rem,4vw,4rem)] text-[0.7rem] font-bold tracking-[0.05em] text-primary">
      <a
        className="inline-flex items-center gap-[0.5em] justify-self-start"
        href={productPath()}
      >
        <img
          src="/brand/logo-header.png"
          alt=""
          width={64}
          height={64}
          className="size-[1em] shrink-0"
          loading="eager"
        />
        bent.shop
      </a>
      <a className="justify-self-center" href={createPath()}>
        create
      </a>
      <div className="justify-self-end">{cart}</div>
    </header>
  );
}
