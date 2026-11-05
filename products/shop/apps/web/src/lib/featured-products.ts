import type { FeaturedProduct } from "@/config/featured-products";

type ProductQuery = Record<string, string | string[] | undefined>;

// Product IDs remain stable when featured slots are reordered or replaced.
export function featuredProductPath(productId: string) {
  return `/featured/${encodeURIComponent(productId)}`;
}

export function legacyFeaturedProductPath(products: readonly FeaturedProduct[], query: ProductQuery) {
  const optionNames = ["featured", "product", "shirtColor", "shirtSize", "toteColor", "toteSize", "Color", "Size"];
  if (!optionNames.some(name => query[name] !== undefined)) return undefined;
  const slot = Array.isArray(query["featured"]) ? query["featured"][0] : query["featured"];
  const product = products.find(candidate => String(candidate.slot) === (slot ?? "1"));
  if (!product) return undefined;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (name === "featured" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
  }
  const search = params.toString();
  return `${featuredProductPath(product.productId)}${search ? `?${search}` : ""}`;
}
