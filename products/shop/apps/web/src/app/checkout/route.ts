import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { getCartData } from "@/lib/cart-data";
import {
  CartIntegrityError,
  persistedProductId,
} from "@/lib/cart-integrity";
import {
  assertSalesIntakeOpen,
  SALES_PAUSE_MESSAGE,
  SalesIntakeDependencyError,
} from "@/server/sales-intake";
import { bindOrderManagementCapability } from "@/server/order-management-capability";
import { ensureCheckoutArtworkNote } from "@/server/checkout-artwork-note";
import { PrintAssetsPendingError, revalidateCartLineCapability } from "@/server/variant-mapping";

const CART_REVALIDATION_MESSAGE =
  "One or more cart items changed. Review your cart and try again.";

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  try {
    await assertSalesIntakeOpen();
  } catch (error) {
    const log = error instanceof SalesIntakeDependencyError ? console.error : console.warn;
    log("[bent.shop checkout] admission failed", {
      requestId, operation: "checkout", stage: "sales_intake", ...safeErrorDetails(error),
    });
    return cartRedirect(request, SALES_PAUSE_MESSAGE, requestId);
  }
  const cart = (await getCartData()).cart;
  if (!cart?.checkoutUrl || cart.totalQuantity < 1) {
    return cartRedirect(request, "Your cart is empty.", requestId);
  }
  let checkoutLocation = cart.checkoutUrl;
  try {
    const upgrades = new Map<string, string>();
    await Promise.all(cart.lines.nodes.map(async (line) => {
      const attributes = line.attributes.flatMap(({ key, value }) =>
        value === null ? [] : [{ key, value }]
      );
      const productId = persistedProductId(attributes);
      const capabilities = attributes.filter(
        ({ key }) => key === "_lineCapability",
      );
      const capability = capabilities[0]?.value;
      if (capabilities.length !== 1 || !capability) {
        throw new CartIntegrityError("The cart line is missing its capability.");
      }
      const upgraded = await revalidateCartLineCapability(
        capability,
        productId,
        line.merchandise.id,
        line.quantity,
      );
      if (upgraded) upgrades.set(line.id, upgraded);
    }));
    checkoutLocation = await ensureCheckoutArtworkNote(cart, upgrades);
    await bindOrderManagementCapability(cart.id, cart.attributes);
  } catch (error) {
    const log = error instanceof PrintAssetsPendingError ? console.warn : console.error;
    log("[bent.shop checkout] admission failed", {
      requestId, operation: "checkout", stage: "cart_validation", ...safeErrorDetails(error),
      durationMs: Math.round(performance.now() - startedAt),
    });
    return cartRedirect(request, error instanceof PrintAssetsPendingError ? error.message : CART_REVALIDATION_MESSAGE, requestId);
  }
  const checkoutUrl = new URL(checkoutLocation);
  if (checkoutUrl.protocol !== "https:") {
    console.error("[bent.shop checkout] invalid checkout URL", { requestId, operation: "checkout", code: "INVALID_CHECKOUT_URL" });
    return cartRedirect(request, "Checkout is unavailable. Please try again.", requestId);
  }
  console.info("[bent.shop checkout] handoff", { requestId, durationMs: Math.round(performance.now() - startedAt) });
  const response = new Response(null, { status: 307, headers: { Location: checkoutUrl.toString(), "x-request-id": requestId } });
  return response;
}

function cartRedirect(request: Request, message: string, requestId?: string) {
  const url = new URL("/cart", request.url);
  url.searchParams.set("cartError", message);
  return new Response(null, { status: 303, headers: { Location: url.toString(), ...(requestId ? { "x-request-id": requestId } : {}) } });
}
