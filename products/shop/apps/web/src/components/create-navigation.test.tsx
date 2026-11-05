// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CreateDesignAction } from "@/components/product-configurator";
import { SiteHeader } from "@/components/site-header";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a data-client-router-link href={href}>{children}</a>
  ),
}));

describe("creation entry navigation", () => {
  it("keeps the site header sticky without reserving a second header row", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<SiteHeader cart="cart" />);

    const header = container.querySelector("header");
    expect(header?.classList.contains("sticky")).toBe(true);
    expect(header?.classList.contains("fixed")).toBe(false);
    expect(header?.classList.contains("-mb-12")).toBe(true);
  });

  it("uses client navigation for the header create link", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<SiteHeader cart="cart" />);

    const create = container.querySelector('a[href="/create"]');
    expect(create?.textContent.trim()).toBe("create");
    expect(create?.hasAttribute("data-client-router-link")).toBe(true);
    expect(container.querySelector('a[href="/"]')
      ?.hasAttribute("data-client-router-link")).toBe(true);
  });

  it("uses client navigation for Make your own", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CreateDesignAction />);

    const create = container.querySelector('a[href="/create"]');
    expect(create?.textContent.trim()).toBe("Make your own");
    expect(create?.hasAttribute("data-client-router-link")).toBe(true);
  });
});
