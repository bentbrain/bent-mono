import { z } from 'zod';

const productPath = /^\/(?:product|products|featured)\/([a-f0-9-]{36})\/?$/i;
const shopProductUrlSchema = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const match = productPath.exec(url.pathname);
  return (
    url.origin === 'https://shop.bent.build' &&
    !url.username &&
    !url.password &&
    Boolean(match && z.uuid().safeParse(match[1]).success)
  );
}, 'Use a product link from shop.bent.build.');

export const shopDesignSchema = z.object({
  productUrl: shopProductUrlSchema,
  color: z.enum(['black', 'white']),
});
export type ShopDesign = z.infer<typeof shopDesignSchema>;

export function shopDesignImage(design: ShopDesign) {
  const id = productPath.exec(new URL(design.productUrl).pathname)?.[1];
  if (!id) throw new Error('Shop product required');
  return `https://shop.bent.build/api/configured-product-image/current/${id}/${design.color}.webp?geometry=physical-print-area-v1&access=revocable-v1&width=768`;
}

export function shopDesignLink(design: ShopDesign) {
  const url = new URL(design.productUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set('Color', design.color === 'black' ? 'Black' : 'White');
  url.searchParams.set('utm_source', 'jp.bent.build');
  url.searchParams.set('utm_medium', 'post');
  return url.href;
}
