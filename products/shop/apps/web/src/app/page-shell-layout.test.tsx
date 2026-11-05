// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import Home from "@/app/page";
import ProductPage from "@/app/product/[id]/page";

vi.mock("@/components/product-page-content", () => ({
  ProductPageContent: () => <div>Product page</div>,
}));

describe("page shell layout", () => {
  it("lets the landing page fill the shell without adding a second viewport", () => {
    const main = renderMain(
      <Home searchParams={Promise.resolve({})} />,
    );

    expect(main.classList.contains("flex-1")).toBe(true);
    expect(main.classList.contains("min-h-dvh")).toBe(false);
  });

  it("lets configured product pages fill the shell without hiding the footer", () => {
    const main = renderMain(
      <ProductPage
        params={Promise.resolve({ id: "product-id" })}
        searchParams={Promise.resolve({})}
      />,
    );

    expect(main.classList.contains("flex-1")).toBe(true);
    expect(main.classList.contains("min-h-dvh")).toBe(false);
  });
});

function renderMain(node: ReactNode) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(node);
  const main = container.querySelector("main");
  if (!main) throw new Error("Expected a page main element.");
  return main;
}
