// Diagnostics accept no free-form customer values. Keep request/route metadata
// useful without retaining capabilities, request bodies or error messages.
const ROUTE_SEGMENTS = new Set([
  "", "api", "v1", "v2", "internal", "operations", "create", "design",
  "featured", "product", "products", "cart", "manage-order", "privacy", "terms",
  "shipping", "returns", "content-rules", "contact", "designs", "design-drafts",
  "configured-products", "configured-product-families", "background-removal",
  "design-upload-grants", "upload-grants", "claim", "artwork", "preview",
  "artwork-sources", "source", "processed", "original", "product-preview",
  "product-image", "product-images", "product-purchase-readiness", "product-availability",
  "creation-trace", "webhooks", "shopify", "printify", "paid", "orders",
  "cart-product-context", "cart-line-capabilities", "order-management",
  "order-management-capabilities", "sales-intake", "sales-pause", "catalogue",
  "variant-mapping", "featured-products", "story-video", "story-videos", "native-video",
  "status", "health", "print-assets", "print-asset-reconciliation", "transfer",
  "product-image-render", "lifecycle", "cancel", "address", "capability",
]);

export function diagnosticRoute(path: string): string {
  const segments = path.split(/[?#]/, 1)[0]?.split("/") ?? [];
  const dynamicParents = new Set(["design", "featured", "product", "products", "designs",
    "design-drafts", "configured-products", "configured-product-families", "design-upload-grants",
    "cart-product-context", "product-preview", "product-image", "product-purchase-readiness"]);
  const privateRouteIndex = segments.indexOf("manage-order");
  return segments
    .map((segment, index) => dynamicParents.has(segments[index - 1] ?? "") ||
      (privateRouteIndex >= 0 && index > privateRouteIndex) ? "[id]"
      : ROUTE_SEGMENTS.has(segment) ? segment : "[id]")
    .join("/").slice(0, 300);
}

export function diagnosticRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value)
    ? value : undefined;
}

const ERROR_TYPES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "URIError", "EvalError", "AggregateError", "AbortError", "TimeoutError",
  "DesignApiError", "PrintQualityError", "CartIntegrityError", "CartDependencyError",
  "VariantMappingDependencyError", "SalesIntakeDependencyError",
  "DependencyUnavailable", "DatabaseFailure", "ArtworkStorageFailure",
]);

export function safeErrorDetails(error: unknown) {
  const name = error instanceof Error ? error.name : undefined;
  const tag = typeof error === "object" && error !== null && "_tag" in error
    ? error._tag : undefined;
  const errorType = typeof tag === "string" && ERROR_TYPES.has(tag) ? tag
    : name && ERROR_TYPES.has(name) ? name : "UnknownError";
  const stackFrames = error instanceof Error && typeof error.stack === "string"
    ? error.stack.split("\n").slice(1, 25).flatMap(line => {
        // V8 / Firefox locations only. Drop messages, arguments, function names,
        // URL hosts, local home directories, query strings and fragments.
        const match = /(?:\(|@|\s)([^\s()]+):(\d+):(\d+)\)?$/.exec(line);
        const raw = match?.[1];
        const lineNumber = match?.[2];
        const columnNumber = match?.[3];
        if (!raw || !lineNumber || !columnNumber || /[?#]/.test(raw)) return [];
        const root = /(?:\/_next\/static\/|\/\.next\/|\/src\/|\/node_modules\/)/.exec(raw);
        const file = root ? raw.slice(root.index)
          : raw.startsWith("node:") ? raw
          // Wrangler emits the API and print executor as this static module.
          // Retain its generated position so its private source map remains useful.
          : raw === "index.js" ? raw : undefined;
        if (!file || !/^[A-Za-z0-9_./:[\]@-]{1,240}$/.test(file)) return [];
        return [`${file}:${lineNumber}:${columnNumber}`];
      }).slice(0, 12)
    : [];
  return { errorType, stackFrames };
}
