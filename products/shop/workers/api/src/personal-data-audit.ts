export type PersonalDataActor =
  | "system:shopify-webhook"
  | "system:paid-order-reconciliation";

export type PersonalDataAction = "receive" | "read";

export type PersonalDataPurpose =
  | "paid-order-ingestion"
  | "fraud-address-line-validation";

export async function recordPersonalDataAccess(
  db: D1Database,
  access: {
    readonly action: PersonalDataAction;
    readonly actor: PersonalDataActor;
    readonly purpose: PersonalDataPurpose;
    readonly subject: string;
  },
  occurredAt: number,
) {
  const subjectHash = await sha256Hex(access.subject);
  const result = await db.prepare(`
    INSERT INTO personal_data_access_log (
      id, subject_hash, actor, action, purpose, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    subjectHash,
    access.actor,
    access.action,
    access.purpose,
    occurredAt,
  ).run();
  if (result.meta.changes !== 1) {
    throw new Error("Protected-data access audit could not be recorded.");
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
