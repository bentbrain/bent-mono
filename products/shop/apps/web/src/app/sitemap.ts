import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  // Only the public storefront belongs in search discovery.
  return [{ url: "https://shop.bent.build/" }];
}
