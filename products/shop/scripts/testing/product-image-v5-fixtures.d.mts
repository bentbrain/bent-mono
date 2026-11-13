import type { ImageRecipe } from "@forever-tee/product-image-renderer";
export const fixtureFunctionArn: string;
export function hash(bytes: Uint8Array): string;
export function fixtureRecipe(color?: ImageRecipe["color"], view?: ImageRecipe["view"], baseProductSlug?: ImageRecipe["baseProductSlug"], depth?: number, printMode?: ImageRecipe["printMode"]): ImageRecipe;
export function fixtureEvent(): { kind: "product-image-v5"; schemaVersion: 1; jobId: string; grant: string; rendererVersion: "product-images-v5" };
export function fixtureBinding(apiOrigin: string, buildId?: string): { schemaVersion: 1; environment: "local-proof"; apiOrigin: string; functionArn: string; qualifiedFunctionArns: string[]; buildId: string };
export function fixtureContext(version?: string): { invokedFunctionArn: string; awsRequestId: string; getRemainingTimeInMillis: () => number };
export function syntheticSources(): Promise<{ png: Buffer; jpeg: Buffer; webp: Buffer; exifJpeg: Buffer }>;
export function createProductImageV5Fixture(options: { source: Uint8Array; recipe?: ImageRecipe; mode?: string }): Promise<{
  origin: string;
  calls: { path: string; method?: string; executionId?: string | string[]; rendererVersion?: string | string[] }[];
  publications: { bytes: Buffer; sha256: string; executionId?: string | string[]; length?: string; claimedHash?: string | string[] }[];
  failures: { executionId?: string | string[]; owned: boolean }[];
  readonly stored: Buffer | undefined;
  close(): Promise<void>;
}>;
