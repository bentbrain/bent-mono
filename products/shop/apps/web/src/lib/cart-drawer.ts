export const CART_DRAWER_ID = "cart-drawer";
export const CART_DRAWER_OPEN_EVENT = "bent-shirt:open-cart";
export const CART_TRIGGER_ID = "cart-trigger";

let cartDrawerRequested = false;

export function openCartDrawer() {
  if (typeof document === "undefined") return;
  cartDrawerRequested = true;
  document.dispatchEvent(new Event(CART_DRAWER_OPEN_EVENT));
}

export function takeCartDrawerOpenRequest() {
  const requested = cartDrawerRequested;
  cartDrawerRequested = false;
  return requested;
}
