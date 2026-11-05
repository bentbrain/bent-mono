import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    // Crawlers must reach customer routes to read their noindex metadata.
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://shop.bent.build/sitemap.xml",
  };
}
