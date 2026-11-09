import { createHash } from "node:crypto";
import { protectedConfig } from "./protected-config.mjs";

// Exact UTF-8 secret bytes are independently approved before they can supply
// records. The snapshot hash covers JSON.stringify(package.snapshot) bytes.
export function approvedForwardRecoveryPackage(encoded, sourceCommit) {
  const check = (value, reason) => { if (!value) throw Error(`Development forward recovery package stopped: ${reason}`); };
  check(typeof encoded === "string" && Buffer.byteLength(encoded) > 0 && Buffer.byteLength(encoded) <= 48 * 1024,
    "protected package must contain at most 48 KiB of UTF-8 JSON.");
  check(createHash("sha256").update(encoded).digest("hex") === protectedConfig("developmentForwardRecoveryPackageSha256"),
    "independently reviewed protected package hash required.");
  const value = JSON.parse(encoded);
  check(value?.schemaVersion === 1 && Object.keys(value).sort().join() === "authority,schemaVersion,snapshot,sourceCommit" &&
    /^[a-f0-9]{40}$/.test(sourceCommit ?? "") && value.sourceCommit === sourceCommit &&
    value.sourceCommit === protectedConfig("developmentForwardRecoverySourceCommit") && value.authority?.sourceCommit === sourceCommit,
    "exact current-source package schema required.");
  check(value.authority.snapshot && Object.keys(value.authority.snapshot).join() === "sha256" && value.snapshot &&
    createHash("sha256").update(JSON.stringify(value.snapshot)).digest("hex") === value.authority.snapshot.sha256 &&
    value.authority.snapshot.sha256 === protectedConfig("developmentForwardRecoverySnapshotSha256"),
    "approved snapshot bytes and hash-only template required.");
  return value;
}
