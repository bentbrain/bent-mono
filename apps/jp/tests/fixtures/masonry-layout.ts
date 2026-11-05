import { expect, type Locator } from '@playwright/test';

// Wait for measurements after image decode, native video metadata or resize.
// Position/order/packing assertions remain separate from this settling signal.
export async function settleMasonry(grid: Locator, gap = 7) {
  await expect(grid).toHaveAttribute('data-masonry-ready', '');
  await expect
    .poll(() =>
      grid
        .locator(':scope > :not([hidden])')
        .evaluateAll(
          (tiles, gap) =>
            tiles.every(
              (tile) =>
                getComputedStyle(tile).gridRowEnd ===
                `span ${String(Math.ceil(tile.getBoundingClientRect().height + gap))}`,
            ),
          gap,
        ),
    )
    .toBe(true);
}
