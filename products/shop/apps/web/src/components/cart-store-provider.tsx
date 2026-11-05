"use client";

import type { ReactNode } from "react";

import { CartDrawer } from "@/components/cart-drawer";
import { CartRouteController } from "@/components/cart-route-controller";
import { SiteHeader } from "@/components/site-header";
import { CartProvider } from "@/lib/cart";
import type { cartHandlers } from "@/lib/cart-handlers";

type CartData = Awaited<ReturnType<typeof cartHandlers.get>>["data"];

export function CartStoreProvider({
  cartData,
  children,
}: {
  cartData: CartData | Promise<CartData>;
  children: ReactNode;
}) {
  return <CartProvider initialData={cartData}>{children}</CartProvider>;
}

export function CartChromeStoreProvider({
  cartData,
}: {
  cartData: CartData | Promise<CartData>;
}) {
  // Keep Hydrogen's provider and chrome consumers in one client module graph.
  return (
    <CartProvider initialData={cartData}>
      <SiteHeader />
      <CartRouteController />
      <CartDrawer />
    </CartProvider>
  );
}
