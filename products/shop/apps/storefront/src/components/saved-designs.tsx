"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

import { Plus } from "lucide-react";
import type { FeaturedProduct } from "@/config/featured-products";
import { featuredProductPath } from "@/lib/featured-products";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { getSavedDesigns } from "@/client/design-api";
import {
  configuredProductImagePath,
  productImageSrcSet,
  sizedProductImagePath,
} from "@/lib/product-image";
import { productPath } from "@/lib/products";
import { Button } from "@/components/ui/button";

export function SavedDesigns({
  featured = [],
}: {
  featured?: readonly (FeaturedProduct & {
    color: string;
    mockupPath?: string;
  })[];
}) {
  const grid = useRef<HTMLDivElement>(null);
  const focusNewDesign = useRef<number | null>(null);
  const designs = useInfiniteQuery({
    queryKey: ["saved-designs", "pages"],
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) => getSavedDesigns(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: false,
  });
  const items = designs.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    if (designs.isFetchingNextPage || focusNewDesign.current === null) return;
    const index = focusNewDesign.current;
    focusNewDesign.current = null;
    if (!designs.isFetchNextPageError) {
      const links = grid.current?.querySelectorAll<HTMLAnchorElement>(
        "a[data-saved-design]",
      );
      if (links && links.length > 0) {
        links
          .item(Math.min(index, links.length - 1))
          .focus({ preventScroll: true });
      }
    }
  }, [designs.data, designs.isFetchingNextPage, designs.isFetchNextPageError]);

  return (
    <section aria-label="Products" className="mx-auto max-w-6xl">
      <div ref={grid} className="grid grid-cols-3 gap-3 sm:gap-5">
        {featured.map((product, index) => (
          <ProductTile
            key={product.productId}
            href={featuredProductPath(product.productId)}
            label={`Open featured design ${String(product.slot)}`}
            productId={product.productId}
            color={product.color}
            eager={index < 3}
            mockupPath={product.mockupPath}
          />
        ))}
        {items.map((design, index) => (
          <ProductTile
            key={design.id}
            href={productPath(design.productId)}
            label={`Open saved design ${String(index + 1)}`}
            productId={design.productId}
            color={design.color}
            saved
          />
        ))}
        <a
          href="/create"
          aria-label="Make your own"
          className={`${tileClass} grid place-items-center hover:bg-primary hover:text-primary-foreground`}
        >
          <Plus
            aria-hidden="true"
            className="size-8 sm:size-12"
            strokeWidth={1}
          />
        </a>
      </div>
      {designs.isPending && (
        <p className="py-4 text-center text-xs" role="status">
          Loading your designs…
        </p>
      )}
      {designs.isError && !designs.data && (
        <div className="py-4 text-center text-xs">
          <p role="alert">Your saved designs couldn&apos;t be loaded.</p>
          <button
            className="mt-3 min-h-11 px-4 underline"
            onClick={() => void designs.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      )}
      <p className="sr-only" role="status">
        {items.length} saved designs shown.
      </p>
      {designs.isFetchNextPageError && (
        <p className="mt-4 text-center text-xs" role="alert">
          More designs couldn&apos;t be loaded.
        </p>
      )}
      {designs.hasNextPage && (
        <div className="mt-4 text-center">
          <Button
            className="min-h-11 rounded-none border-primary bg-background px-5 font-mono text-xs text-primary shadow-none hover:bg-primary hover:text-primary-foreground"
            variant="outline"
            disabled={designs.isFetching}
            type="button"
            onClick={(event) => {
              if (designs.isFetching) return;
              if (document.activeElement === event.currentTarget)
                focusNewDesign.current = items.length;
              void designs.fetchNextPage({ cancelRefetch: false });
            }}
          >
            {designs.isFetchingNextPage
              ? "Loading…"
              : designs.isFetchNextPageError
                ? "Try again"
                : "Load more"}
          </Button>
        </div>
      )}
    </section>
  );
}

const tileClass =
  "block aspect-square min-w-0 overflow-hidden border border-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary";

function ProductTile({
  href,
  label,
  productId,
  color,
  saved = false,
  eager = false,
  mockupPath,
}: {
  href: string;
  label: string;
  productId: string;
  color: string;
  saved?: boolean;
  eager?: boolean;
  mockupPath?: string | undefined;
}) {
  const imagePath = configuredProductImagePath({ color, productId });
  return (
    <SavedDesignLink href={href} aria-label={label} saved={saved}>
      <img
        alt=""
        className="h-full w-full object-contain"
        height={512}
        width={512}
        loading={eager ? "eager" : "lazy"}
        src={mockupPath ?? sizedProductImagePath(imagePath, 384)}
        srcSet={
          mockupPath
            ? undefined
            : productImageSrcSet(imagePath, [192, 384, 768])
        }
        sizes="(min-width: 1280px) 371px, 30vw"
      />
    </SavedDesignLink>
  );
}

// Warm only the product the visitor points at, focuses or touches.
function SavedDesignLink({
  children,
  href,
  saved,
  "aria-label": label,
}: {
  children: ReactNode;
  href: string;
  saved: boolean;
  "aria-label": string;
}) {
  const [intent, setIntent] = useState(false);
  return (
    <a
      href={href}
      className={tileClass}
      aria-label={label}
      data-saved-design={saved ? "" : undefined}

      onPointerEnter={() => {
        setIntent(true);
      }}
      onFocus={() => {
        setIntent(true);
      }}
      onTouchStart={() => {
        setIntent(true);
      }}
    >
      {intent ? <link rel="prefetch" href={href} /> : null}
      {children}
    </a>
  );
}
