import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateCharacterManifest } from "../../../../packages/asset-contracts/src/index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectPngSources(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPngSources(item));
  }
  if (!isRecord(value)) {
    return [];
  }

  const ownSource =
    typeof value.source === "string" && value.source.endsWith(".png")
      ? [value.source]
      : [];
  return [
    ...ownSource,
    ...Object.values(value).flatMap((item) => collectPngSources(item)),
  ];
}

const manifestArgument = process.argv[2];
if (manifestArgument === undefined) {
  console.error("Usage: validate_manifest.ts <manifest-path>");
  process.exit(2);
}

const projectRoot = process.cwd();
const manifestPath = resolve(projectRoot, manifestArgument);
const manifestText = await readFile(manifestPath, "utf8");
const manifest: unknown = JSON.parse(manifestText);
const result = validateCharacterManifest(manifest);
const missingSources: string[] = [];

if (result.ok) {
  for (const source of collectPngSources(manifest)) {
    try {
      await access(resolve(projectRoot, source));
    } catch {
      missingSources.push(`Missing sprite file: ${source}`);
    }
  }
}

const errors = [...result.errors, ...missingSources];
if (errors.length > 0) {
  for (const error of errors) {
    console.error(`FAIL: ${error}`);
  }
  process.exit(1);
}

console.log(`PASS: ${manifestArgument}`);
