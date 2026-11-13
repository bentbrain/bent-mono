import { createFileRoute } from "@tanstack/react-router";
import { CartPage } from "@/components/cart-page";
export const Route = createFileRoute("/cart")({
  validateSearch: (search: Record<string, unknown>) => ({
    cartError:
      typeof search["cartError"] === "string" ? search["cartError"] : undefined,
  }),
  component: Cart,
});
function Cart() {
  const { cartError } = Route.useSearch();
  return <CartPage {...(cartError ? { initialError: cartError } : {})} />;
}
