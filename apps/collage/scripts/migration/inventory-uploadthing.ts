import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { UTApi } from "uploadthing/server";
import { z } from "zod";
import {
  jsonLines,
  prepareDirectory,
  requiredEnvironment,
  timestampedArtifactDirectory,
} from "./common";

const uploadThingTokenSchema = z.object({ appId: z.string().min(1) });
const token = requiredEnvironment("UPLOADTHING_TOKEN");
const tokenPayload: unknown = JSON.parse(
  Buffer.from(token, "base64").toString("utf8"),
);
const { appId } = uploadThingTokenSchema.parse(tokenPayload);
const uploadThing = new UTApi({ token, logLevel: "Error" });
const artifactDirectory = timestampedArtifactDirectory("uploadthing-inventory");
await prepareDirectory(artifactDirectory);

const inventory = [];
let offset = 0;
let hasMore = true;
while (hasMore) {
  const page = await uploadThing.listFiles({ limit: 100, offset });
  if (page.files.length === 0 && page.hasMore) {
    throw new Error("UploadThing returned an empty page with hasMore=true");
  }
  inventory.push(
    ...page.files.map((file) => ({
      ...file,
      sourceUrl: `https://${appId}.ufs.sh/f/${encodeURIComponent(file.key)}`,
    })),
  );
  offset += page.files.length;
  hasMore = page.hasMore;
}

const contents = jsonLines(inventory);
const usage = await uploadThing.getUsageInfo();
await writeFile(path.join(artifactDirectory, "objects.jsonl"), contents, {
  mode: 0o600,
});
await writeFile(
  path.join(artifactDirectory, "manifest.json"),
  `${JSON.stringify(
    {
      inventoriedAt: new Date().toISOString(),
      objectCount: inventory.length,
      uploadedObjectCount: inventory.filter(
        (file) => file.status === "Uploaded",
      ).length,
      totalBytes: inventory.reduce((total, file) => total + file.size, 0),
      uploadThingUsage: usage,
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  `Inventoried ${inventory.length} UploadThing objects in ${artifactDirectory}`,
);
