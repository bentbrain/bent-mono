/** Deployment identities are supplied by the protected release environment. */
export function protectedConfig(key) {
  const encoded = process.env.SHOP_PROTECTED_CONFIG_JSON;
  if (!encoded) throw new Error("Shop protected configuration is required. Set SHOP_PROTECTED_CONFIG_JSON through the protected environment.");
  let values;
  try { values = JSON.parse(encoded); }
  catch { throw new Error("Shop protected configuration must be a JSON object."); }
  const value = values?.[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("{{SHOP:")) {
    throw new Error(`Shop protected configuration is missing ${key}.`);
  }
  return value;
}

