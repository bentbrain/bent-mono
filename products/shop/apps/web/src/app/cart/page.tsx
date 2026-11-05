import { CartPage } from "@/components/cart-page";
import { CartStoreProvider } from "@/components/cart-store-provider";
import { getCartData } from "@/lib/cart-data";

// The fallback route intentionally blocks so its response contains usable cart
// markup without relying on React's client-side streaming reveal script.
export const instant = false;

export default async function CartRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [cartData, query] = await Promise.all([getCartData(), searchParams]);
  const cartError = typeof query["cartError"] === "string"
    ? query["cartError"].slice(0, 300)
    : undefined;

  return (
    <CartStoreProvider cartData={cartData}>
      <CartPage {...(cartError ? { initialError: cartError } : {})} />
    </CartStoreProvider>
  );
}
