import "server-only";
import { storedProductImageResponse } from "./product-image-bff";

// Cloudflare checks the current product and revision before reading R2. No
// storefront cache can retain access after deletion, suspension or unpublish.
export const configuredProductImageResponse = storedProductImageResponse;
