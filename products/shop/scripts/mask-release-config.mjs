// Register each protected leaf before operational inspections. A JSON secret alone
// does not mask individual identities or embedded evidence fields in errors.
const values = new Set();
function collect(value, publicIdentityRoot = false) {
  if (typeof value === "string") {
    if (value) values.add(value);
    try { collect(JSON.parse(value), publicIdentityRoot); } catch { /* Ordinary string leaf. */ }
  } else if (value && typeof value === "object") {
    for (const [name, child] of Object.entries(value)) {
      // These are the new, publicly discoverable monorepo identity fields.
      // Signed identity proof logs must retain them for trust verification.
      if (publicIdentityRoot && ["githubRepositoryId", "githubOwnerId"].includes(name)) continue;
      collect(child);
    }
  }
}
for (const name of ["SHOP_PROTECTED_CONFIG_JSON", "SHOP_EVIDENCE_ENCRYPTION_KEY", "SHOP_EVIDENCE_PREVIOUS_KEYS_JSON"]) {
  if (process.env[name]) collect(process.env[name], name === "SHOP_PROTECTED_CONFIG_JSON");
}
for (const value of values) {
  const escaped = value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stdout.write(`::add-mask::${escaped}\n`);
}
