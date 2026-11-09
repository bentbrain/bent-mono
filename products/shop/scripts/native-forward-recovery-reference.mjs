const check = value => { if (!value) throw Error("Forward recovery requires exact immutable authority and plan references."); };
export function forwardRecoveryObject(reference, filename) {
  check(reference && Object.keys(reference).sort().join() === "key,sha256,version" &&
    new RegExp(`^source/releases/native-[1-9][0-9]*/${filename.replaceAll(".", "\\.")}$`).test(reference.key ?? "") &&
    typeof reference.version === "string" && /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(reference.version) && reference.version !== "null" &&
    /^[a-f0-9]{64}$/.test(reference.sha256 ?? ""));
  return reference;
}
export function forwardRecoveryReference(encoded, execution) {
  check(typeof encoded === "string" && Buffer.byteLength(encoded) <= 4096);
  const value = JSON.parse(encoded);
  check(value?.schemaVersion === 1 && Object.keys(value).sort().join() ===
    (execution ? "authority,plan,schemaVersion" : "authority,schemaVersion"));
  forwardRecoveryObject(value.authority, "forward-recovery-authority.json");
  if (execution) forwardRecoveryObject(value.plan, "forward-recovery-plan.json");
  return value;
}
