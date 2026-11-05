import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shopDesignSchema,
  shopDesignImage,
  shopDesignLink,
} from '../src/lib/shop-design';

const id = '3d8ed467-55d4-45ed-ba9d-1eeb687fa5bc';

void test('shop designs use flat images and link to the chosen garment colour', () => {
  for (const color of ['black', 'white']) {
    const design = shopDesignSchema.parse({
      productUrl: `https://shop.bent.build/featured/${id}?Color=Black#size`,
      color,
    });
    assert.equal(
      shopDesignImage(design),
      `https://shop.bent.build/api/configured-product-image/current/${id}/${color}.webp?geometry=physical-print-area-v1&access=revocable-v1&width=768`,
    );
    const link = new URL(shopDesignLink(design));
    assert.equal(link.pathname, `/featured/${id}`);
    assert.equal(
      link.searchParams.get('Color'),
      color === 'black' ? 'Black' : 'White',
    );
    assert.equal(link.hash, '');
  }
});

void test('only shop product links and black or white are accepted', () => {
  for (const productUrl of [
    '',
    'invalid',
    `http://shop.bent.build/product/${id}`,
    `https://shop.bent.build.evil.example/product/${id}`,
    `https://evil.example/product/${id}`,
    `https://owner:secret@shop.bent.build/product/${id}`,
    'https://shop.bent.build/create',
    'https://shop.bent.build/product/not-a-product',
    `https://shop.bent.build:444/product/${id}`,
  ])
    assert.equal(
      shopDesignSchema.safeParse({ productUrl, color: 'white' }).success,
      false,
    );
  assert.equal(
    shopDesignSchema.safeParse({
      productUrl: `https://shop.bent.build/product/${id}`,
      color: 'cream',
    }).success,
    false,
  );
});
