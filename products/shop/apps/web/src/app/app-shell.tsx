import { StorefrontScripts } from "./storefront-scripts";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";

import { Providers } from "@/app/providers";
import { CartChromeStoreProvider } from "@/components/cart-store-provider";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCartData } from "@/lib/cart-data";
import { routeTemplates } from "@/lib/route-templates";
import { getShopifyConfig, shopifyI18n } from "@/lib/shopify-config";

export function AppShell({
  children,
}: {
  children: ReactNode;
}) {
  const config = getShopifyConfig();

  return (
    <Providers>
      <Suspense fallback={<SiteHeader cart={<Link href="/cart">cart</Link>} />}>
        <CartChrome />
      </Suspense>
      {children}
      <SiteFooter />
      <Suspense fallback={null}><StorefrontScripts
        i18n={shopifyI18n}
        routes={routeTemplates}
        shop={{
          shopId: config.shopId,
          storefrontId: config.storefrontId,
          myshopifyDomain: config.storeDomain,
        }}
      /></Suspense>
    </Providers>
  );
}

async function CartChrome() {
  await connection();
  const cartData = getCartData();

  return (
    <CartChromeStoreProvider cartData={cartData} />
  );
}
