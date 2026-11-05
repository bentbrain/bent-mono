"use client";

import Link from "next/link";

import { useCart } from "@/lib/cart";
import {
  CART_DRAWER_ID,
  CART_TRIGGER_ID,
  openCartDrawer,
} from "@/lib/cart-drawer";

export function CartLink() {
  const quantity = useCart((state) => state.data.totalQuantity);

  return (
    <Link
      href="/cart"
      prefetch={false}
      id={CART_TRIGGER_ID}
      aria-controls={CART_DRAWER_ID}
      aria-haspopup="dialog"
      onClick={(event) => {
        event.preventDefault();
        openCartDrawer();
      }}
    >
      cart
      {quantity > 0 ? (
        <span aria-label={`${String(quantity)} items in cart`}>
          {` (${String(quantity)})`}
        </span>
      ) : null}
    </Link>
  );
}
