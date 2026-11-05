// @vitest-environment happy-dom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProductPageSkeleton } from "@/components/route-skeletons";

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) =>
    createElement("img", { alt, src }),
}));

describe("ProductPageSkeleton", () => {
  it("renders the stable product mockup while commerce data loads", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<ProductPageSkeleton />);

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector('[aria-label="Loading product image"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Loading price and availability"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-product-skeleton="selector"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-product-skeleton="options"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-product-skeleton="actions"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-product-skeleton="details"]'),
    ).not.toBeNull();
    const skeletonBlocks = [
      ...container.querySelectorAll("[data-skeleton-block]"),
    ];
    expect(skeletonBlocks.length).toBeGreaterThan(0);
    for (const block of skeletonBlocks) {
      expect(block.classList.contains("border-dotted")).toBe(true);
      expect(block.classList.contains("border-primary")).toBe(true);
      expect(block.classList.contains("bg-surface")).toBe(true);
    }
  });
});
