import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  jsonLines,
  parseJsonLines,
  prepareDirectory,
  timestampedArtifactDirectory,
  uploadThingKeyFromUrl,
} from "./common";

const collageSchema = z.object({
  legacyId: z.number().int().positive(),
  userId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
  collageJson: z.string(),
  imageUrl: z.string().url(),
  public: z.boolean(),
  nsfw: z.boolean(),
  version: z.number().int().positive(),
});
const mappingSchema = z.object({
  sourceKey: z.string(),
  finalKey: z.string(),
  finalUrl: z.string().url(),
  category: z.enum(["collage", "payload", "unknown"]),
});
type Mapping = z.infer<typeof mappingSchema>;

const postgresExportDirectory = process.argv[2];
const mappingsFile = process.argv[3];
if (!postgresExportDirectory || !mappingsFile) {
  throw new Error(
    "Usage: bun run migration:prepare-convex-import <postgres-export-directory> <url-mappings.jsonl>",
  );
}

const collages = await parseJsonLines(
  path.join(postgresExportDirectory, "collages.jsonl"),
  collageSchema,
);
const mappings = await parseJsonLines(mappingsFile, mappingSchema);
const mappingsBySourceKey = new Map(
  mappings.map((mapping) => [mapping.sourceKey, mapping]),
);
const unresolvedKeys = new Set<string>();
let rewrittenCanvasUrls = 0;

function rewriteValue(value: unknown): unknown {
  if (typeof value === "string") {
    const key = uploadThingKeyFromUrl(value);
    if (!key) return value;
    const mapping = mappingsBySourceKey.get(key);
    if (!mapping) {
      unresolvedKeys.add(key);
      return value;
    }
    rewrittenCanvasUrls += 1;
    return mapping.finalUrl;
  }
  if (Array.isArray(value)) return value.map(rewriteValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteValue(item)]),
    );
  }
  return value;
}

function renderMapping(imageUrl: string, legacyId: number): Mapping {
  const key = uploadThingKeyFromUrl(imageUrl);
  const mapping = key ? mappingsBySourceKey.get(key) : undefined;
  if (!key || mapping?.category !== "collage") {
    throw new Error(`Missing verified render mapping for collage ${legacyId}`);
  }
  return mapping;
}

const rewrittenCollages = collages.map((collage) => {
  const render = renderMapping(collage.imageUrl, collage.legacyId);
  const canvas: unknown = JSON.parse(collage.collageJson);
  return {
    ...collage,
    collageJson: JSON.stringify(rewriteValue(canvas)),
    imageUrl: render.finalUrl,
    renderObjectKey: render.finalKey,
  };
});
if (unresolvedKeys.size > 0) {
  throw new Error(
    `${unresolvedKeys.size} UploadThing canvas references do not have verified R2 mappings`,
  );
}

const preferences = await readFile(
  path.join(postgresExportDirectory, "userPreferences.jsonl"),
  "utf8",
);
const counters = await readFile(
  path.join(postgresExportDirectory, "idCounters.jsonl"),
  "utf8",
);
const outputFiles = {
  "collages.jsonl": jsonLines(rewrittenCollages),
  "userPreferences.jsonl": preferences,
  "idCounters.jsonl": counters,
};
const artifactDirectory = timestampedArtifactDirectory("convex-import");
await prepareDirectory(artifactDirectory);
await Promise.all(
  Object.entries(outputFiles).map(([filename, contents]) =>
    writeFile(path.join(artifactDirectory, filename), contents, {
      mode: 0o600,
    }),
  ),
);
await writeFile(
  path.join(artifactDirectory, "manifest.json"),
  `${JSON.stringify(
    {
      preparedAt: new Date().toISOString(),
      collages: rewrittenCollages.length,
      rewrittenRenderUrls: rewrittenCollages.length,
      rewrittenCanvasUrls,
      unresolvedCanvasKeys: unresolvedKeys.size,
      files: Object.fromEntries(
        Object.entries(outputFiles).map(([filename, contents]) => [
          filename,
          createHash("sha256").update(contents).digest("hex"),
        ]),
      ),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  `Prepared ${rewrittenCollages.length} Convex collages in ${artifactDirectory}`,
);
