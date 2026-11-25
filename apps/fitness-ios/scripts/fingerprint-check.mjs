// Checks that the native fingerprint, which decides whether a build can take
// a JavaScript update, ignores JavaScript changes and follows native ones:
// Swift in the fitness-health module and its config plugin.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFingerprintAsync } from "@expo/fingerprint";

const root = fileURLToPath(new URL("..", import.meta.url));
const fingerprint = async () => (await createFingerprintAsync(root, { platforms: ["ios"], silent: true })).hash;

async function withChange(path, line, check) {
  const file = new URL(`../${path}`, import.meta.url);
  const original = await readFile(file);
  try {
    await appendFile(file, line);
    return await check();
  } finally {
    await writeFile(file, original);
  }
}

const base = await fingerprint();
const cases = [
  ["src/App.tsx", "\n// fingerprint check\n", false],
  ["modules/fitness-health/ios/Core/Version.swift", "\n// fingerprint check\n", true],
  ["modules/fitness-health/app.plugin.js", "\n// fingerprint check\n", true],
];
const failures = [];
for (const [path, line, moves] of cases) {
  const changed = await withChange(path, line, fingerprint);
  const moved = changed !== base;
  console.log(`${path}: fingerprint ${moved ? "changed" : "kept"}`);
  if (moved !== moves) failures.push(`${path} should ${moves ? "change" : "keep"} the fingerprint.`);
}
if ((await fingerprint()) !== base) failures.push("The fingerprint did not return to its base value.");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Fingerprint ${base} follows native changes only.`);
