"use client";

import { useEffect } from "react";

import { configureStandardOpenCart } from "@/lib/configure-standard-open-cart";
import { openCartDrawer } from "@/lib/cart-drawer";

export function CartRouteController() {
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    const configure = () => {
      if (!configureStandardOpenCart(window.Shopify, openCartDrawer)) {
        if (!stopped) timer = window.setTimeout(configure, 50);
      }
    };

    configure();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return null;
}
