import type { ComponentProps } from "react";

import { PreparationSpinner } from "@/components/camera-preparing";

export function ProductPageSkeleton() {
  return (
    <div
      className="relative animate-pulse motion-reduce:animate-none"
      role="status"
      aria-label="Loading product details"
    >
      <ProductSelectorSkeleton />
      <div className="mx-auto grid max-w-[1400px] grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)] gap-[clamp(2rem,5vw,6rem)] max-[900px]:grid-cols-1 max-[900px]:gap-0">
        <SkeletonBlock
          className="aspect-square w-full"
          data-product-skeleton="media"
          aria-label="Loading product image"
        />
        <ProductCommerceSkeleton />
      </div>
      <span className="sr-only">Loading product details…</span>
    </div>
  );
}

function ProductSelectorSkeleton() {
  return (
    <div
      className="mx-auto flex min-h-14 max-w-[1400px] items-center min-[901px]:absolute min-[901px]:inset-x-0 min-[901px]:top-0 min-[901px]:grid min-[901px]:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)] min-[901px]:gap-[clamp(2rem,5vw,6rem)]"
      data-product-skeleton="selector"
      aria-hidden="true"
    >
      <div className="flex w-fit items-center gap-2 min-[901px]:col-start-2 min-[901px]:pl-3">
        <SkeletonBlock className="h-11 w-24" />
        <SkeletonBlock className="h-11 w-24" />
      </div>
    </div>
  );
}

function ProductCommerceSkeleton() {
  return (
    <div
      className="self-start bg-background min-[901px]:pt-14 max-[900px]:pb-[env(safe-area-inset-bottom)]"
      data-product-skeleton="commerce"
      aria-label="Loading price and availability"
    >
      <div
        className="grid gap-2 px-3 py-4"
        data-product-skeleton="options"
        aria-hidden="true"
      >
        <SkeletonBlock className="h-11 w-20 justify-self-end" />
        <div className="flex h-11 items-end gap-3">
          <div className="flex gap-1.5">
            <SkeletonBlock className="size-11 shrink-0" />
            <SkeletonBlock className="size-11 shrink-0" />
          </div>
          <SkeletonBlock className="h-11 min-w-0 flex-1" />
        </div>
      </div>

      <div
        className="grid gap-[0.55rem] px-3 py-3"
        data-product-skeleton="actions"
        aria-hidden="true"
      >
        <SkeletonBlock className="h-14 max-[900px]:h-12" />
        <div className="flex gap-[0.55rem]">
          <SkeletonBlock className="h-14 w-20 shrink-0 max-[900px]:h-12" />
          <SkeletonBlock className="h-14 min-w-0 flex-1 max-[900px]:h-12" />
        </div>
        <div className="grid gap-2 py-1">
          <SkeletonBlock className="h-3 w-60 max-w-full" />
          <SkeletonBlock className="h-3 w-56 max-w-full" />
        </div>
      </div>

      <div
        className="flex min-h-12 items-center justify-between gap-3 px-3"
        data-product-skeleton="details"
        aria-hidden="true"
      >
        <SkeletonBlock className="h-3 w-28" />
        <SkeletonBlock className="size-6" />
      </div>
      <span className="sr-only">Loading price, variants and availability…</span>
    </div>
  );
}

function SkeletonBlock({ className = "", ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={`${className} border border-dotted border-primary bg-surface`}
      data-skeleton-block
    />
  );
}

export function DesignPageSkeleton() {
  return (
    <main
      className="grid flex-1 place-items-center bg-background pt-12 text-primary"
      role="status"
      aria-label="Loading design"
    >
      <PreparationSpinner />
      <span className="sr-only">Loading design…</span>
    </main>
  );
}
