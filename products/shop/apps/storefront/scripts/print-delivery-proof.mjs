import assert from "node:assert/strict";

export async function verifyDuplicatePrintDelivery(db, deliverPrint) {
  const before = await db
    .prepare("SELECT id,status,sha256 FROM print_assets ORDER BY id")
    .all();
  assert.ok(before.success === true && Array.isArray(before.results), "Successful print asset query required before duplicate delivery");
  await deliverPrint(true);
  const after = await db
    .prepare("SELECT id,status,sha256 FROM print_assets ORDER BY id")
    .all();
  assert.ok(after.success === true && Array.isArray(after.results), "Successful print asset query required after duplicate delivery");
  assert.deepEqual(after.results, before.results, "Print asset rows changed after duplicate delivery");
}
