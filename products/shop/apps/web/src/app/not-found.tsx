import { handleShopifyRedirects } from "@shopify/hydrogen";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { routeTemplates } from "@/lib/route-templates";
import { getShopifyConfig } from "@/lib/shopify-config";
import {
  createPrivateStorefrontClient,
  getBuyerIp,
} from "@/lib/storefront";
import { productPath } from "@/lib/products";

export default function NotFound() {
  return (
    <>
      <Suspense fallback={null}>
        <ShopifyRedirectResolver />
      </Suspense>
      <main className="grid flex-1 place-items-center p-8 text-center">
        <div>
          <p className="text-xs">404</p>
          <h1 className="mt-3 text-4xl font-bold">Page not found.</h1>
          <Link className="mt-6 inline-block underline" href={productPath()} prefetch>
            Go home
          </Link>
        </div>
      </main>
    </>
  );
}

async function ShopifyRedirectResolver() {
  await connection();
  const requestHeaders = await headers();
  const url = requestHeaders.get("x-storefront-url");
  const buyerIp = getBuyerIp(requestHeaders);

  if (url && new URL(url).pathname === "/admin") {
    redirect(new URL("/admin", `https://${getShopifyConfig().storeDomain}`).toString());
  }

  if (url && buyerIp) {
    const result = await handleShopifyRedirects({
      request: new Request(url),
      routeTemplates,
      storefrontClient: createPrivateStorefrontClient(
        { headers: requestHeaders, url },
        buyerIp,
      ),
    });
    const location = result?.headers.get("location");
    if (location) redirect(location);
  }

  return null;
}
