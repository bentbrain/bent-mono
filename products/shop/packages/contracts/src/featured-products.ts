export type FeaturedSlot = 1 | 2 | 3 | 4 | 5 | 6;

export interface FeaturedProduct {
  readonly slot: FeaturedSlot;
  readonly productId: string;
}

export function isFeaturedSlot(value: unknown): value is FeaturedSlot {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6;
}

export function parseFeaturedProducts(value: unknown): readonly FeaturedProduct[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return;
  const products: FeaturedProduct[] = [];
  for (const item of value) {
    const product = parseFeaturedProduct(item);
    if (!product || products.some(existing => existing.slot === product.slot || existing.productId === product.productId)) return;
    products.push(product);
  }
  return products.sort((left, right) => left.slot - right.slot);
}

function parseFeaturedProduct(value: unknown): FeaturedProduct | undefined {
  if (typeof value !== "object" || value === null ||
      !("slot" in value) || !isFeaturedSlot(value.slot) ||
      !("productId" in value) || typeof value.productId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.productId) ||
      Object.keys(value).some(key => key !== "slot" && key !== "productId")) return;
  return { slot: value.slot, productId: value.productId };
}
