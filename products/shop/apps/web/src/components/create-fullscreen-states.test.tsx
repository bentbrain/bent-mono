// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProcessedCutoutReveal } from "@/components/processed-cutout-reveal";
import { ProcessingPiercingLoader } from "@/components/processing-piercing-loader";

vi.mock("next/image", () => ({
  default: ({ alt, className }: { alt: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} className={className} />
  ),
}));

describe("create fullscreen states", () => {
  it("pins the processing state to one dynamic viewport without overscroll", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <ProcessingPiercingLoader imageUrl="/portrait.jpg" />,
    );

    const loader = container.querySelector('[role="status"]');
    expect(loader?.className).toContain("fixed");
    expect(loader?.className).toContain("inset-0");
    expect(loader?.className).toContain("h-dvh");
    expect(loader?.className).toContain("w-dvw");
    expect(loader?.className).toContain("overscroll-none");
  });

  it("pins the loaded reveal to one dynamic viewport", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <ProcessedCutoutReveal
        imageUrl="/cutout.png"
        onCovered={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    const reveal = container.querySelector("canvas");
    expect(reveal?.className).toContain("fixed");
    expect(reveal?.className).toContain("inset-0");
    expect(reveal?.className).toContain("h-dvh");
    expect(reveal?.className).toContain("w-dvw");
    expect(reveal?.className).toContain("overscroll-none");
  });
});
