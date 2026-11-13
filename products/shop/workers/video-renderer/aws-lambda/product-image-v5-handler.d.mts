import type { ProductImageExecutionResult } from "@forever-tee/product-image-renderer/execution";
export function validateProductImageV5Binding(value: unknown): Readonly<{
  schemaVersion: 1;
  environment: "development" | "production" | "local-proof";
  apiOrigin: string;
  functionArn: string;
  qualifiedFunctionArns: readonly string[];
  buildId: string;
}>;
export function validateProductImageV5Event(value: unknown): {
  jobId: string;
  grant: string;
  rendererVersion: "product-images-v5";
};
export function assertProductImageV5Invocation(context: unknown, binding: ReturnType<typeof validateProductImageV5Binding>): void;
export function createProductImageV5Handler(options: {
  binding: unknown;
  assetDirectory: string;
}): (event: unknown, context: unknown) => Promise<ProductImageExecutionResult["body"]>;
