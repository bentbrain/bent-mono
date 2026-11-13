"use client";

import { XIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CART_DRAWER_ID,
  CART_DRAWER_OPEN_EVENT,
  CART_TRIGGER_ID,
  takeCartDrawerOpenRequest,
} from "@/lib/cart-drawer";

// Keep the accessible shell immediate; only download line controls on opening.
const DeferredCartContents = lazy(() =>
  import("@/components/cart-page")
    .then((module) => ({ default: module.CartContents }))
    .catch(() => ({ default: CartContentUnavailable })),
);
function CartContents() {
  return (
    <Suspense fallback={<p role="status">Loading cart…</p>}>
      <DeferredCartContents layout="overlay" />
    </Suspense>
  );
}

function CartContentUnavailable() {
  return (
    <div className="grid min-h-0 flex-1 content-center p-6 text-center">
      <a href="/cart" className="underline">
        Open cart page
      </a>
    </div>
  );
}

export function CartDrawer() {
  const [drawerOpen, setDrawerOpen] = useState(takeCartDrawerOpenRequest);
  useEffect(() => {
    const openDrawer = () => {
      takeCartDrawerOpenRequest();
      setDrawerOpen(true);
    };
    document.addEventListener(CART_DRAWER_OPEN_EVENT, openDrawer);

    return () => {
      document.removeEventListener(CART_DRAWER_OPEN_EVENT, openDrawer);
    };
  }, []);

  return (
    <Dialog
      open={drawerOpen}
      onOpenChange={(open) => {
        setDrawerOpen(open);
        if (!open) {
          requestAnimationFrame(() => {
            document.getElementById(CART_TRIGGER_ID)?.focus({
              preventScroll: true,
            });
          });
        }
      }}
    >
      <DialogContent
        id={CART_DRAWER_ID}
        className="flex max-h-[min(760px,calc(100svh-6rem))] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-none border border-primary bg-background p-0 pt-10 text-primary ring-0"
        showCloseButton={false}
        style={{
          maxWidth: "680px",
          top: "calc(50% + 1.5rem)",
        }}
      >
        <DialogTitle className="sr-only">Cart</DialogTitle>
        <DialogDescription className="sr-only">
          Review your items before checkout.
        </DialogDescription>
        <DialogClose
          className="absolute top-3 right-4 z-20 grid size-8 shrink-0 place-items-center border border-primary bg-background"
          aria-label="Close cart"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </DialogClose>
        <CartContents />
      </DialogContent>
    </Dialog>
  );
}
