// These contracts are consumed by the storefront and API. The renderer imports
// only product-mockup-geometry.js, including in its explicit Lambda source bundle.
// New files and package/config changes remain conservative until reviewed here.
const applicationContracts = new Set([
  'cart.ts', 'cart-line-capability.ts', 'design.ts', 'index.ts', 'limits.ts',
  'order-management.ts', 'product.ts', 'product-projection.ts',
  'story-video-grants.js', 'story-video-grants.d.ts',
]);
export function applicationContractPath(path) {
  const prefix = 'packages/contracts/src/';
  return path.startsWith(prefix) && applicationContracts.has(path.slice(prefix.length));
}
