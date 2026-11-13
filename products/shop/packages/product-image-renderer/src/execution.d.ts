import type { renderProductDisplay } from "@forever-tee/product-image-renderer";

export interface ProductImageEvent {
  jobId: string;
  grant: string;
  rendererVersion: "product-images-v5";
}
export interface ProductImageTimings {
  assetReadMs: number;
  renderMs: number;
  uploadMs: number;
  totalMs: number;
}
export interface ProductImageExecutionResult {
  status: 200 | 503;
  body:
    | { jobId: string; status: "skipped" }
    | { jobId: string; executionId: string; key: string; sha256: string; size: number; timings: ProductImageTimings }
    | { error: "IMAGE_RENDER_UNAVAILABLE" };
  headers?: { "cache-control": "no-store" };
}
export function boundedImageTransfer(response: Response, maximum: number): Promise<Buffer>;
export function parseProductImageEvent(event: unknown): ProductImageEvent | undefined;
export function executeProductImage(
  event: ProductImageEvent,
  options: {
    apiUrl: string;
    assetDirectory: string;
    render?: typeof renderProductDisplay;
    runtimeLabel?: "Vercel" | "native v5";
  },
): Promise<ProductImageExecutionResult>;
