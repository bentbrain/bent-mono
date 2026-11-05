import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function hasNoPendingMigrations(output) {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).map(line => line.trim());
  return lines.filter(line => line === "✅ No migrations to apply!").length === 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !/^[A-Z][A-Z0-9_]*$/.test(process.argv[2])) throw new Error("Provide the configured D1 binding name.");
  let output;
  try {
    output = execFileSync("bun", ["x", "wrangler", "d1", "migrations", "list", process.argv[2], "--remote"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("Unable to verify pending D1 migrations. No migration or deployment was performed.");
  }
  if (!hasNoPendingMigrations(output)) throw new Error("Pending or unrecognized migrations require a separately approved release procedure.");
  console.log("No pending D1 migrations.");
}
