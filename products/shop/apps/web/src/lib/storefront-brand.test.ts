import { describe, expect, it } from "vitest";

import {
  STOREFRONT_NAME,
  storefrontProductTitle,
} from "@/lib/storefront-brand";

describe("storefrontProductTitle", () => {
  it("rebrands the legacy shirt title without renaming other products", () => {
    expect(storefrontProductTitle("Bent Shirt")).toBe(STOREFRONT_NAME);
    expect(storefrontProductTitle("Cotton Tote")).toBe("Cotton Tote");
  });
});
