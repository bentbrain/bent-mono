import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  databaseConnectionString,
  jsonLines,
  parseJsonLines,
  prepareDirectory,
  timestampedArtifactDirectory,
  uploadThingKeyFromUrl,
} from "./common";

const inventoryObjectSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  key: z.string(),
  status: z.enum(["Deletion Pending", "Failed", "Uploaded", "Uploading"]),
  sourceUrl: z.string().url(),
});
const collageReferenceSchema = z.object({
  id: z.number().int().positive(),
  image_url: z.string().url(),
  collage_json: z.unknown(),
});
const mediaReferenceSchema = z.object({
  id: z.number().int().positive(),
  filename: z.string(),
  url: z.string().nullable(),
  key: z.string().nullable(),
});

function collectStrings(value: unknown, result: string[]): void {
  if (typeof value === "string") {
    result.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, result);
  }
}

function safePayloadFilename(filename: string): string {
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    throw new Error(`Unsafe Payload filename: ${filename}`);
  }
  return filename;
}

const inventoryFile = process.argv[2];
if (!inventoryFile) {
  throw new Error(
    "Usage: bun run migration:classify-references <path-to-objects.jsonl>",
  );
}
const inventory = await parseJsonLines(inventoryFile, inventoryObjectSchema);
const database = neon(databaseConnectionString());
const [rawCollages, rawMedia] = await database.transaction(
  [
    database`
      select id, image_url, collage_json
      from drizzle_maya_collage_collage
      order by id asc
    `,
    database`
      select id, filename, url, _key as key
      from media
      order by id asc
    `,
  ],
  { isolationLevel: "RepeatableRead", readOnly: true },
);
const collages = z.array(collageReferenceSchema).parse(rawCollages);
const media = z.array(mediaReferenceSchema).parse(rawMedia);
const collageRenderKeys = new Set<string>();
const embeddedAssetKeys = new Set<string>();
const mediaByKey = new Map<string, (typeof media)[number]>();
const mediaById = new Map(media.map((item) => [item.id, item]));
const preferredMediaKeyById = new Map<number, string>();
const inventoryByName = new Map<string, (typeof inventory)[number][]>();
const referenceSources = new Map<string, Set<string>>();

for (const item of inventory) {
  const matches = inventoryByName.get(item.name) ?? [];
  matches.push(item);
  inventoryByName.set(item.name, matches);
}

function recordReference(key: string, source: string): void {
  const sources = referenceSources.get(key) ?? new Set<string>();
  sources.add(source);
  referenceSources.set(key, sources);
}

for (const collage of collages) {
  const renderKey = uploadThingKeyFromUrl(collage.image_url);
  if (renderKey) {
    collageRenderKeys.add(renderKey);
    recordReference(renderKey, `collage-render:${collage.id}`);
  }
  const strings: string[] = [];
  collectStrings(collage.collage_json, strings);
  for (const value of strings) {
    const key = uploadThingKeyFromUrl(value);
    if (key) {
      embeddedAssetKeys.add(key);
      recordReference(key, `collage-canvas:${collage.id}`);
    }
  }
}
for (const item of media) {
  if (item.key) {
    mediaByKey.set(item.key, item);
    recordReference(item.key, `payload-key:${item.id}`);
  }
  const urlKey = item.url ? uploadThingKeyFromUrl(item.url) : null;
  if (item.url) {
    if (urlKey) {
      mediaByKey.set(urlKey, item);
      recordReference(urlKey, `payload-url:${item.id}`);
    }
  }
  const preferredKey = urlKey ?? item.key;
  if (preferredKey) preferredMediaKeyById.set(item.id, preferredKey);
}

const inventoryKeys = new Set(inventory.map((item) => item.key));
const referencedKeys = new Set([
  ...collageRenderKeys,
  ...embeddedAssetKeys,
  ...mediaByKey.keys(),
]);
const sourceOrigin = new URL(inventory[0]?.sourceUrl ?? "https://ufs.sh")
  .origin;
const missingReferences = await Promise.all(
  [...referencedKeys]
    .filter((key) => !inventoryKeys.has(key))
    .map(async (key) => {
      const sources = [...(referenceSources.get(key) ?? [])];
      const payloadMediaIds = sources
        .filter((source) => source.startsWith("payload-"))
        .map((source) => Number(source.split(":")[1]))
        .filter((id) => Number.isSafeInteger(id));
      const filenameCandidateKeys = payloadMediaIds.flatMap((id) => {
        const filename = mediaById.get(id)?.filename;
        return filename
          ? (inventoryByName.get(filename) ?? []).map((item) => item.key)
          : [];
      });
      const response = await fetch(
        `${sourceOrigin}/f/${encodeURIComponent(key)}`,
        { headers: { Range: "bytes=0-0" } },
      );
      await response.body?.cancel();
      return {
        key,
        sources,
        filenameCandidateKeys: [...new Set(filenameCandidateKeys)],
        sourceHttpStatus: response.status,
        availableAtSource: response.ok,
      };
    }),
);
const usedDestinationKeys = new Set<string>();
const classifications = inventory.map((source) => {
  const mediaItem = mediaByKey.get(source.key);
  const category = collageRenderKeys.has(source.key)
    ? "collage"
    : mediaItem || embeddedAssetKeys.has(source.key)
      ? "payload"
      : "unknown";
  const sourceKeyHash = createHash("sha256").update(source.key).digest("hex");
  const stagedKey = `migration/uploadthing/${sourceKeyHash}`;
  const canonicalPayloadObject =
    mediaItem !== undefined &&
    preferredMediaKeyById.get(mediaItem.id) === source.key;
  const finalKey =
    category === "collage"
      ? `collages/${randomBytes(16).toString("hex")}.jpg`
      : category === "payload" && mediaItem && canonicalPayloadObject
        ? `payload/media/${safePayloadFilename(mediaItem.filename)}`
        : `migration/orphans/${sourceKeyHash}`;
  if (usedDestinationKeys.has(finalKey)) {
    throw new Error(`Duplicate destination key: ${finalKey}`);
  }
  usedDestinationKeys.add(finalKey);
  return {
    sourceKey: source.key,
    sourceUrl: source.sourceUrl,
    sourceName: source.name,
    sourceSize: source.size,
    sourceStatus: source.status,
    category,
    stagedKey,
    finalKey,
    referencedAsCollageRender: collageRenderKeys.has(source.key),
    referencedInCanvas: embeddedAssetKeys.has(source.key),
    payloadMediaId: mediaItem?.id,
    canonicalPayloadObject,
  };
});

const artifactDirectory = timestampedArtifactDirectory(
  "reference-classification",
);
await prepareDirectory(artifactDirectory);
await Promise.all([
  writeFile(
    path.join(artifactDirectory, "classification.jsonl"),
    jsonLines(classifications),
    { mode: 0o600 },
  ),
  writeFile(
    path.join(artifactDirectory, "missing-references.jsonl"),
    jsonLines(missingReferences),
    { mode: 0o600 },
  ),
  writeFile(
    path.join(artifactDirectory, "manifest.json"),
    `${JSON.stringify(
      {
        classifiedAt: new Date().toISOString(),
        sourceObjects: inventory.length,
        categories: {
          collage: classifications.filter((item) => item.category === "collage")
            .length,
          payload: classifications.filter((item) => item.category === "payload")
            .length,
          unknown: classifications.filter((item) => item.category === "unknown")
            .length,
        },
        references: {
          collageRenderKeys: collageRenderKeys.size,
          embeddedAssetKeys: embeddedAssetKeys.size,
          payloadMediaKeys: mediaByKey.size,
          canonicalPayloadObjects: preferredMediaKeyById.size,
          referencedKeysMissingFromInventory: [...referencedKeys].filter(
            (key) => !inventoryKeys.has(key),
          ).length,
          missingReferencesAvailableAtSource: missingReferences.filter(
            (item) => item.availableAtSource,
          ).length,
          missingReferencesWithFilenameCandidates: missingReferences.filter(
            (item) => item.filenameCandidateKeys.length > 0,
          ).length,
          payloadRowsWithoutSourceKey: media.filter(
            (item) =>
              !item.key &&
              (!item.url || uploadThingKeyFromUrl(item.url) === null),
          ).length,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  ),
]);
console.log(
  `Classified ${classifications.length} objects in ${artifactDirectory}`,
);
