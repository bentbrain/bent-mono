import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ShippingPage from "@/app/shipping/page";
import { ShippingTimingCopy } from "@/components/shipping-timing";

vi.mock("@/lib/fulfilment-estimate-data", () => ({
  getCachedStorefrontFulfilmentEstimate: vi.fn(),
}));

describe("ShippingPage", () => {
  it("states the production, delivery, and price estimates", () => {
    const html = renderToStaticMarkup(<ShippingPage />);
    const timing = renderToStaticMarkup(
      <ShippingTimingCopy
        estimate={{
          production: { maximumBusinessDays: 5, minimumBusinessDays: 3 },
          standardDelivery: {
            maximumBusinessDays: 6,
            minimumBusinessDays: 3,
          },
        }}
      />,
    );

    expect(html).toContain("Last updated 1 September 2026");
    expect(timing).toContain("<p>- production: 3 to 5 business days</p>");
    expect(timing).toContain("<p>- shipping: 3 to 6 business days</p>");
    expect(timing).not.toContain("<ul");
    expect(timing).not.toContain("<li");
    expect(html).toContain(
      "Shipping costs AUD $10.95 when the discounted merchandise subtotal is below AUD $100",
    );
    expect(html).toContain(
      "Shipping is free when the discounted merchandise subtotal is AUD $100 or more",
    );
    expect(html).not.toMatch(/standard (delivery|shipping)/i);
  });
});
