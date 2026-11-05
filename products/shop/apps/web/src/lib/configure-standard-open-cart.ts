export function configureStandardOpenCart(
  shopify: unknown,
  onOpen: () => void,
) {
  if (!isRecord(shopify)) return false;
  const actions = shopify["actions"];
  if (!isRecord(actions)) return false;
  const openCart = actions["openCart"];
  if (!isRecord(openCart)) return false;
  const configure = openCart["configure"];
  if (typeof configure !== "function") return false;

  configure.call(openCart, {
    handler: async () => {
      onOpen();
      await Promise.resolve();
    },
  });
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
