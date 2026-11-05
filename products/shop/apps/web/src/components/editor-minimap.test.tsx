import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EditorMinimap } from "@/components/editor-minimap";

describe("EditorMinimap", () => {
  it("renders non-blocking live T-shirt and tote previews on opposite corners", () => {
    const html = renderToStaticMarkup(
      <EditorMinimap
        defaultColor="White"
        canvasRef={createRef<HTMLCanvasElement>()}
        toteCanvasRef={createRef<HTMLCanvasElement>()}
      />,
    );

    expect(html).toContain("Live T-shirt preview");
    expect(html).toContain("Live cotton tote preview");
    expect(html).toContain('data-editor-minimap="staple-tee"');
    expect(html).toContain('data-editor-minimap="cotton-tote"');
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("top-3 right-3");
    expect(html).toContain("top-3 left-3");
    expect(html).toContain("size-[6.5rem]");
    expect(html).toContain("tote-cream-print-bar-1001.webp");
    expect(html).not.toContain("rounded-md");
    expect(html).not.toContain("shadow-");
    expect(html).toContain("<canvas");
    expect(html).toContain('width="120" height="150"');
    expect(html).toContain('width="120" height="145"');
    expect(html).not.toContain('type="range"');
  });
});
