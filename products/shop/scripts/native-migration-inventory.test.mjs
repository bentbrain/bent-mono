import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

import {
  isReviewedAppliedMigrationPrefix,
  isReviewedMigrationInventory,
  NATIVE_MIGRATION_COUNT,
  NATIVE_MIGRATION_LATEST,
} from "./native-migration-inventory.mjs";

const inventory = Array.from(
  { length: NATIVE_MIGRATION_COUNT },
  (_, index) => `${String(index).padStart(4, "0")}_migration.sql`,
);
inventory[inventory.length - 1] = NATIVE_MIGRATION_LATEST;

test("native releases accept only the exact current migration inventory", () => {
  assert.equal(isReviewedMigrationInventory(inventory), true);
  assert.equal(isReviewedMigrationInventory(inventory.slice(0, -1)), false);
  assert.equal(isReviewedMigrationInventory([...inventory, "0028_extra.sql"]), false);
  assert.equal(isReviewedMigrationInventory([
    ...inventory.slice(0, -1),
    "0027_other.sql",
  ]), false);
});

test("reviewed inventory matches the checked-in migrations", async () => {
  const migrations = (await readdir(new URL("../workers/api/drizzle/", import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();

  assert.equal(isReviewedMigrationInventory(migrations), true);
});

test("native releases accept only a known ordered migration prefix", () => {
  for (let length = 18; length <= inventory.length; length += 1) {
    assert.equal(
      isReviewedAppliedMigrationPrefix(inventory, inventory.slice(0, length)),
      true,
    );
  }
  assert.equal(
    isReviewedAppliedMigrationPrefix(inventory, inventory.slice(0, 17)),
    false,
  );
  assert.equal(
    isReviewedAppliedMigrationPrefix(inventory, [
      ...inventory.slice(0, 20),
      "0020_substituted.sql",
    ]),
    false,
  );
});
