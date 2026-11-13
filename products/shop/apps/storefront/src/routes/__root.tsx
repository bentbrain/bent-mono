import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { PublicConfigContext } from "../public-config";
import styles from "../styles.css?url";
import { CartStoreProvider } from "@/components/cart-store-provider";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { CartDrawer } from "@/components/cart-drawer";
import { CartRouteController } from "@/components/cart-route-controller";
import { ShopifyScripts } from "@shopify/hydrogen/react";
import { routeTemplates } from "@/lib/route-templates";

const config = createServerFn({ method: "GET" }).handler(async () => {
  const { runtimeEnv } = await import("../server/runtime-env");
  const { getCartData } = await import("../lib/cart-data");
  const value = runtimeEnv();
  return {
    turnstileSiteKey: value.TURNSTILE_SITE_KEY,
    cart: await getCartData(),
    shop: {
      shopId: value.SHOP_ID ?? "0",
      storefrontId: value.PUBLIC_STOREFRONT_ID ?? "0",
      myshopifyDomain: value.PUBLIC_STORE_DOMAIN,
    },
  };
});
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    loader: () => config(),
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "bent.shop" },
      ],
      links: [{ rel: "stylesheet", href: styles }],
    }),
    component: Root,
  },
);
function Root() {
  const { queryClient } = Route.useRouteContext();
  const publicConfig = Route.useLoaderData();
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-dvh flex-col">
        <QueryClientProvider client={queryClient}>
          <PublicConfigContext.Provider value={publicConfig}>
            <NuqsAdapter>
              <CartStoreProvider cartData={publicConfig.cart}>
                <SiteHeader />
                <CartRouteController />
                <CartDrawer />
                <Outlet />
                <SiteFooter />
                <ShopifyScripts
                  i18n={{ country: "AU", language: "EN" }}
                  shop={publicConfig.shop}
                  routes={routeTemplates}
                />
              </CartStoreProvider>
            </NuqsAdapter>
          </PublicConfigContext.Provider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
