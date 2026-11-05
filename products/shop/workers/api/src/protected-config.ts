/** Read only the protected deployment configuration, never request input. */
export function protectedConfig(key: string): string {
  const encoded = process.env["SHOP_PROTECTED_CONFIG_JSON"];
  if (!encoded) throw new Error("Shop protected deployment configuration is required.");
  const values: unknown = JSON.parse(encoded);
  if (typeof values !== "object" || values === null || !Object.hasOwn(values, key)) {
    throw new Error(`Shop protected configuration is missing ${key}.`);
  }
  const value: unknown = Reflect.get(values, key);
  if (typeof value !== "string" || value.length === 0 || value.includes("{{SHOP:")) {
    throw new Error(`Shop protected configuration is missing ${key}.`);
  }
  return value;
}
