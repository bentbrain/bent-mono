import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  jsonLines,
  parseJsonLines,
  prepareDirectory,
  requiredEnvironment,
  timestampedArtifactDirectory,
} from "./common";

const inventoryObjectSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  key: z.string(),
  status: z.enum(["Deletion Pending", "Failed", "Uploaded", "Uploading"]),
  sourceUrl: z.string().url(),
});

type InventoryObject = z.infer<typeof inventoryObjectSchema>;
type CopiedObject = {
  sourceProvider: "uploadthing";
  sourceKey: string;
  sourceUrl: string;
  destinationKey: string;
  destinationUrl: string;
  category: "unknown";
  size: number;
  contentType: string;
  sha256: string;
  copiedAt: number;
  verifiedAt: number;
  reusedExistingObject: boolean;
};
type ExcludedObject = { sourceKey: string; reason: string };

const inventoryFile = process.argv[2];
if (!inventoryFile) {
  throw new Error(
    "Usage: bun run migration:copy-uploadthing <path-to-objects.jsonl>",
  );
}

const bucket = requiredEnvironment("R2_BUCKET");
const publicUrl = requiredEnvironment("R2_PUBLIC_URL").replace(/\/$/, "");
const client = new S3Client({
  region: "auto",
  endpoint: requiredEnvironment("R2_ENDPOINT"),
  forcePathStyle: true,
  credentials: {
    accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
  },
});
const inventory = await parseJsonLines(inventoryFile, inventoryObjectSchema);
const artifactDirectory = timestampedArtifactDirectory("r2-copy");
await prepareDirectory(artifactDirectory);
const copiedObjects: CopiedObject[] = [];
const excludedObjects: ExcludedObject[] = [];
let completedObjects = 0;

async function copyObject(source: InventoryObject): Promise<void> {
  if (source.status !== "Uploaded") {
    excludedObjects.push({
      sourceKey: source.key,
      reason: `UploadThing status is ${source.status}`,
    });
    return;
  }

  const destinationKeyHash = createHash("sha256")
    .update(source.key)
    .digest("hex");
  const destinationKey = `migration/uploadthing/${destinationKeyHash}`;
  const temporaryFile = path.join(
    tmpdir(),
    `maya-collage-${destinationKeyHash}`,
  );
  const response = await fetch(source.sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download UploadThing object ${source.key}`);
  }

  const hash = createHash("sha256");
  try {
    const temporaryHandle = await open(temporaryFile, "w", 0o600);
    let downloadedBytes = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        hash.update(result.value);
        downloadedBytes += result.value.byteLength;
        await temporaryHandle.write(result.value);
      }
    } finally {
      await temporaryHandle.close();
    }
    if (downloadedBytes !== source.size) {
      throw new Error(`Downloaded size mismatch for ${source.key}`);
    }
    const sha256 = hash.digest("hex");
    const existing = await client
      .send(new HeadObjectCommand({ Bucket: bucket, Key: destinationKey }))
      .catch((error: unknown) => {
        if (
          error instanceof S3ServiceException &&
          error.$metadata.httpStatusCode === 404
        ) {
          return null;
        }
        throw error;
      });
    const alreadyCopied =
      existing?.ContentLength === source.size &&
      existing.Metadata?.sha256 === sha256;

    if (!alreadyCopied) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: destinationKey,
          Body: createReadStream(temporaryFile),
          ContentLength: source.size,
          ContentType:
            response.headers.get("content-type") ?? "application/octet-stream",
          Metadata: { sha256 },
        }),
      );
    }
    const verified = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: destinationKey }),
    );
    if (
      verified.ContentLength !== source.size ||
      verified.Metadata?.sha256 !== sha256
    ) {
      throw new Error(`R2 verification failed for ${source.key}`);
    }

    copiedObjects.push({
      sourceProvider: "uploadthing",
      sourceKey: source.key,
      sourceUrl: source.sourceUrl,
      destinationKey,
      destinationUrl: `${publicUrl}/${destinationKey}`,
      category: "unknown",
      size: source.size,
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      sha256,
      copiedAt: Date.now(),
      verifiedAt: Date.now(),
      reusedExistingObject: alreadyCopied,
    });
    completedObjects += 1;
    if (completedObjects % 25 === 0) {
      console.log(`Verified ${completedObjects} uploaded objects`);
    }
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

let nextInventoryIndex = 0;
async function copyWorker(): Promise<void> {
  while (nextInventoryIndex < inventory.length) {
    const source = inventory[nextInventoryIndex];
    nextInventoryIndex += 1;
    if (source) await copyObject(source);
  }
}

const workerCount = Math.min(8, inventory.length);
await Promise.all(
  Array.from({ length: workerCount }, async () => copyWorker()),
);

await Promise.all([
  writeFile(
    path.join(artifactDirectory, "copied-objects.jsonl"),
    jsonLines(copiedObjects),
    { mode: 0o600 },
  ),
  writeFile(
    path.join(artifactDirectory, "excluded-objects.jsonl"),
    jsonLines(excludedObjects),
    { mode: 0o600 },
  ),
]);
console.log(
  `Verified ${copiedObjects.length} objects; recorded ${excludedObjects.length} exclusions in ${artifactDirectory}`,
);
