import { isDeepStrictEqual } from "node:util";

export const NATIVE_MIGRATION_COUNT = 45;
export const NATIVE_MIGRATION_LATEST =
  "0044_video_preview_revisions.sql";

export function isReviewedMigrationInventory(expected) {
  return Array.isArray(expected) &&
    expected.length === NATIVE_MIGRATION_COUNT &&
    expected.at(-1) === NATIVE_MIGRATION_LATEST;
}

export function isReviewedAppliedMigrationPrefix(expected, applied) {
  return isReviewedMigrationInventory(expected) && Array.isArray(applied) &&
    applied.length >= 18 && applied.length <= expected.length &&
    isDeepStrictEqual(applied, expected.slice(0, applied.length));
}
