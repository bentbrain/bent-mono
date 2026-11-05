"use client";
import { ShopifyScripts } from "@shopify/hydrogen/react";
import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";

export function StorefrontScripts(props: ComponentProps<typeof ShopifyScripts>) {
  const pathname = usePathname();
  if (pathname === "/manage-order") return null;
  return <ShopifyScripts {...props} />;
}
