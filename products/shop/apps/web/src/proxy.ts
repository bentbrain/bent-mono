import { handleShopifyRoutes } from "@shopify/hydrogen";
import { NextResponse, type NextRequest } from "next/server";

import { cartBypassRejection } from "@/lib/cart-bypass";
import { cartHandlers } from "@/lib/cart-handlers";
import { getShopifyConfig } from "@/lib/shopify-config";
import { createRequestStorefrontClient } from "@/lib/storefront";

function createSessionManager(request: NextRequest) {
  const items = new Map<string, unknown>();
  return {
    getSessionOrigin() {
      return request.nextUrl.origin;
    },
    getSessionItem(key: string) {
      return items.get(key);
    },
    setSessionItem(key: string, value: unknown) {
      items.set(key, value);
    },
    removeSessionItem(key: string) {
      items.delete(key);
    },
  };
}

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/product-availability") {
    return NextResponse.next();
  }
  const bypassRejection = await cartBypassRejection(request);
  if (bypassRejection) {
    return NextResponse.json(
      { error: bypassRejection },
      { status: 403 },
    );
  }
  if (request.nextUrl.pathname === "/admin") {
    return NextResponse.redirect(
      new URL("/admin", `https://${getShopifyConfig().storeDomain}`),
    );
  }

  const { requestContext, storefrontClient } =
    createRequestStorefrontClient(request);
  // The application owns checkout validation. Hydrogen's default interceptor
  // redirects immediately and forces Shop Pay before the route can run.
  if (request.nextUrl.pathname !== "/checkout") {
    const shopifyRoute = await handleShopifyRoutes({
      request,
      requestContext,
      sessionManager: createSessionManager(request),
      storefrontClient,
      handlers: [cartHandlers],
    });

    if (shopifyRoute) return shopifyRoute;
  }

  const requestHeaders = requestContext.getForwardedRequestHeaders();
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  requestContext.applyResponseHeaders(response.headers);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|_next/data|favicon.ico|mockups/).*)",
  ],
};
