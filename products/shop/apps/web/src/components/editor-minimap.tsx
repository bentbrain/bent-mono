import type { RefObject } from "react";
import type { ProductDefaultColor } from "@forever-tee/contracts";
import Image from "next/image";
import { productProjectionSpecification } from "@forever-tee/contracts/product-projection";

import { GarmentMockup } from "@/components/garment-mockup";
import { productDefaultColorValue } from "@/lib/product-params";
import {
  productProjectionArtworkStyle,
  productProjectionMockupPath,
} from "@/lib/product-projection";

const MINIMAP_CANVAS_WIDTH = 120;

function minimapCanvasHeight(slug: "cotton-tote" | "staple-tee") {
  const { canvas } = productProjectionSpecification(slug);
  return Math.round(
    MINIMAP_CANVAS_WIDTH * (canvas.heightPx / canvas.widthPx),
  );
}

export function EditorMinimap({
  canvasRef,
  defaultColor,
  dragging = false,
  toteCanvasRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  defaultColor: ProductDefaultColor;
  dragging?: boolean;
  toteCanvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  return (
    <>
      <div
        className="pointer-events-none absolute top-3 left-3 z-10 size-[6.5rem] overflow-hidden border border-primary bg-white"
        style={{ opacity: dragging ? 0.8 : 1 }}
        data-editor-minimap="cotton-tote"
        role="img"
        aria-label="Live cotton tote preview"
      >
        <Image
          fill
          src={productProjectionMockupPath("cotton-tote", productDefaultColorValue(defaultColor, "cotton-tote"))}
          alt=""
          sizes="6.5rem"
          className="object-contain"
        />
        <canvas
          ref={toteCanvasRef}
          width={MINIMAP_CANVAS_WIDTH}
          height={minimapCanvasHeight("cotton-tote")}
          aria-hidden="true"
          className="absolute z-[2] h-auto"
          style={productProjectionArtworkStyle("cotton-tote")}
        />
      </div>
      <div
        className="pointer-events-none absolute top-3 right-3 z-10 size-[6.5rem] rounded-full border border-primary"
        style={{ opacity: dragging ? 0.8 : 1 }}
        data-editor-minimap="staple-tee"
      >
        <GarmentMockup
          ariaLabel="Live T-shirt preview"
          className="size-full rounded-full bg-white"
          color={defaultColor}
          preload
          sizes="6.5rem"
        >
          <canvas
            ref={canvasRef}
            width={MINIMAP_CANVAS_WIDTH}
            height={minimapCanvasHeight("staple-tee")}
            aria-hidden="true"
            className="absolute z-[2] h-auto"
            style={productProjectionArtworkStyle("staple-tee")}
          />
        </GarmentMockup>
      </div>
    </>
  );
}
