// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GarmentSizeGuide } from "@/components/garment-details";

describe("GarmentSizeGuide", () => {
  it("leaves the title and description to the dialog and contains its table", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<GarmentSizeGuide />);

    expect(container.querySelector("h3")).toBeNull();
    expect(container.textContent).not.toContain(
      "Garment measurements in centimetres.",
    );
    expect(container.querySelector("section")?.className).toContain("min-w-0");
    expect(container.querySelector("table")?.parentElement?.className)
      .toContain("max-w-full");
  });

  it("fits more measurements on narrow screens and signals horizontal scrolling", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<GarmentSizeGuide />);

    expect(container.querySelector("table")?.className).toContain(
      "min-w-[32rem]",
    );
    expect(container.querySelector("table")?.className).toContain(
      "table-fixed",
    );
    expect(container.querySelector("col")?.className).toContain("w-28");
    expect(container.textContent).toContain("scroll to see all sizes");
  });
});
