// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Providers } from "@/app/providers";
import { useCart } from "@/lib/cart";

function CartConsumerProbe() {
  const quantity = useCart((state) => state.data.totalQuantity);
  return <p>{`Cart quantity: ${String(quantity)}`}</p>;
}

describe("Providers", () => {
  it("provides cart context to page-level Hydrogen consumers", () => {
    const html = renderToStaticMarkup(
      <Providers>
        <CartConsumerProbe />
      </Providers>,
    );

    expect(html).toContain("Cart quantity: 0");
  });
});
