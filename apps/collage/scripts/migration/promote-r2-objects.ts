import {
  CopyObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  jsonLines,
  parseJsonLines,
  prepareDirectory,
  requiredEnvironment,
  timestampedArtifactDirectory,
} from "./common";

const classificationSchema = z.object({
  sourceKey: z.string(),
  sourceUrl: z.string().url(),
  sourceSize: z.number().int().nonnegative(),
  sourceStatus: z.enum(["Deletion Pending", "Failed", "Uploaded", "Uploading"]),
  category: z.enum(["collage", "payload", "unknown"]),
  stagedKey: z.string(),
  finalKey: z.string(),
});
const copiedObjectSchema = z.object({
  sourceKey: z.string(),
  destinationKey: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const classificationFile = process.argv[2];
const copiedObjectsFile = process.argv[3];
if (!classificationFile || !copiedObjectsFile) {
  throw new Error(
    "Usage: bun run migration:promote-r2 <classification.jsonl> <copied-objects.jsonl>",
  );
}

const classifications = await parseJsonLines(
  classificationFile,
  classificationSchema,
);
const copiedObjects = await parseJsonLines(
  copiedObjectsFile,
  copiedObjectSchema,
);
const copiedBySourceKey = new Map(
  copiedObjects.map((item) => [item.sourceKey, item]),
);
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
const mappings: Array<{
  sourceKey: string;
  sourceUrl: string;
  stagedKey: string;
  finalKey: string;
  finalUrl: string;
  category: "collage" | "payload" | "unknown";
  size: number;
  sha256: string;
  reusedExistingObject: boolean;
}> = [];
const exclusions: Array<{ sourceKey: string; reason: string }> = [];
let completedObjects = 0;

function encodedCopySource(key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${encodeURIComponent(bucket)}/${encodedKey}`;
}

async function promoteObject(
  classification: (typeof classifications)[number],
): Promise<void> {
  if (classification.sourceStatus !== "Uploaded") {
    exclusions.push({
      sourceKey: classification.sourceKey,
      reason: `UploadThing status is ${classification.sourceStatus}`,
    });
    return;
  }
  const copied = copiedBySourceKey.get(classification.sourceKey);
  if (copied?.destinationKey !== classification.stagedKey) {
    throw new Error(`Missing staged copy for ${classification.sourceKey}`);
  }
  const existing = await client
    .send(
      new HeadObjectCommand({ Bucket: bucket, Key: classification.finalKey }),
    )
    .catch((error: unknown) => {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 404
      ) {
        return null;
      }
      throw error;
    });
  const alreadyPromoted =
    existing?.ContentLength === copied.size &&
    existing.Metadata?.sha256 === copied.sha256;
  if (!alreadyPromoted) {
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: classification.finalKey,
        CopySource: encodedCopySource(classification.stagedKey),
      }),
    );
  }
  const verified = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: classification.finalKey }),
  );
  if (
    verified.ContentLength !== copied.size ||
    verified.Metadata?.sha256 !== copied.sha256
  ) {
    throw new Error(
      `Final R2 verification failed for ${classification.sourceKey}`,
    );
  }
  mappings.push({
    sourceKey: classification.sourceKey,
    sourceUrl: classification.sourceUrl,
    stagedKey: classification.stagedKey,
    finalKey: classification.finalKey,
    finalUrl: `${publicUrl}/${classification.finalKey}`,
    category: classification.category,
    size: copied.size,
    sha256: copied.sha256,
    reusedExistingObject: alreadyPromoted,
  });
  completedObjects += 1;
  if (completedObjects % 50 === 0) {
    console.log(`Promoted and verified ${completedObjects} objects`);
  }
}

let nextClassificationIndex = 0;
async function promotionWorker(): Promise<void> {
  while (nextClassificationIndex < classifications.length) {
    const classification = classifications[nextClassificationIndex];
    nextClassificationIndex += 1;
    if (classification) await promoteObject(classification);
  }
}

await Promise.all(
  Array.from({ length: Math.min(8, classifications.length) }, () =>
    promotionWorker(),
  ),
);
const artifactDirectory = timestampedArtifactDirectory("r2-promotion");
await prepareDirectory(artifactDirectory);
await Promise.all([
  writeFile(
    path.join(artifactDirectory, "url-mappings.jsonl"),
    jsonLines(mappings),
    { mode: 0o600 },
  ),
  writeFile(
    path.join(artifactDirectory, "excluded-objects.jsonl"),
    jsonLines(exclusions),
    { mode: 0o600 },
  ),
]);
console.log(
  `Promoted ${mappings.length} objects; recorded ${exclusions.length} exclusions in ${artifactDirectory}`,
);
