import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { verifyDuplicatePrintDelivery } from "../apps/storefront/scripts/print-delivery-proof.mjs";

function fixture(t, responses = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE print_assets (id TEXT PRIMARY KEY, status TEXT, sha256 TEXT)");
  sqlite.prepare("INSERT INTO print_assets VALUES (?, ?, ?)").run("print-a", "ready", "a".repeat(64));
  let reads = 0;
  const db = { prepare(sql) {
    assert.equal(sql, "SELECT id,status,sha256 FROM print_assets ORDER BY id");
    return { async all() {
      const index = reads++;
      return { success: true, meta: { duration: index === 0 ? 1 : 0, changes: 0 },
        results: sqlite.prepare(sql).all(), ...responses[index] };
    } };
  } };
  return { db, sqlite, reads: () => reads };
}

test("duplicate print delivery preserves actual SQLite rows despite different query timing", async t => {
  const f = fixture(t), deliveries = [];
  await verifyDuplicatePrintDelivery(f.db, async duplicate => { deliveries.push(duplicate); });
  assert.deepEqual(deliveries, [true]);
  assert.equal(f.reads(), 2);
});

test("duplicate print delivery rejects every selected persistent change", async t => {
  for (const sql of [
    "UPDATE print_assets SET id='print-b'",
    "UPDATE print_assets SET status='pending'",
    "UPDATE print_assets SET sha256='changed'",
    "DELETE FROM print_assets",
    "INSERT INTO print_assets VALUES ('print-b','ready','other')",
  ]) await t.test(sql, async t => {
    const f = fixture(t);
    await assert.rejects(verifyDuplicatePrintDelivery(f.db, async duplicate => {
      assert.equal(duplicate, true); f.sqlite.exec(sql);
    }), /Print asset rows changed/);
  });
});

test("duplicate print proof rejects unsuccessful or incomplete database observations", async t => {
  for (const index of [0, 1]) for (const response of [{ success: false }, { results: undefined }])
    await t.test(`read ${index}: ${Object.keys(response)[0]}`, async t => {
      const f = fixture(t, { [index]: response }); let deliveries = 0;
      await assert.rejects(verifyDuplicatePrintDelivery(f.db, async () => { deliveries++; }), /Successful print asset query/);
      assert.equal(deliveries, index);
    });
});

test("a failed duplicate delivery cannot qualify unchanged print rows", async t => {
  const f = fixture(t);
  await assert.rejects(verifyDuplicatePrintDelivery(f.db, async () => { throw Error("delivery failed"); }), /delivery failed/);
  assert.equal(f.reads(), 1);
});
