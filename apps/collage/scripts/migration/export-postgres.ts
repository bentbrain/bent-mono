import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import {
  databaseConnectionString,
  jsonLines,
  prepareDirectory,
  timestampedArtifactDirectory,
} from "./common";

const collageRowSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date().nullable(),
  collage_json: z.unknown(),
  image_url: z.string().url(),
  public: z.boolean(),
  nsfw: z.boolean(),
});

const preferencesRowSchema = z.object({
  id: z.string(),
  created_at: z.date(),
  updated_at: z.date().nullable(),
  show_nsfw: z.boolean(),
  tutorial_viewed: z.boolean(),
});

const databaseUrl = databaseConnectionString();
const database = neon(databaseUrl);
const artifactDirectory = timestampedArtifactDirectory("postgres-export");
await prepareDirectory(artifactDirectory);

const [rawCollages, rawPreferences] = await database.transaction(
  [
    database`
        select id, user_id, created_at, updated_at, collage_json, image_url, public, nsfw
        from drizzle_maya_collage_collage
        order by id asc
      `,
    database`
        select id, created_at, updated_at, show_nsfw, tutorial_viewed
        from drizzle_maya_collage_user_preferences
        order by id asc
      `,
  ],
  { isolationLevel: "RepeatableRead", readOnly: true },
);
const snapshot = {
  collages: z.array(collageRowSchema).parse(rawCollages),
  preferences: z.array(preferencesRowSchema).parse(rawPreferences),
};

const collages = snapshot.collages.map((row) => ({
  legacyId: row.id,
  ...(row.user_id ? { userId: row.user_id } : {}),
  createdAt: row.created_at.getTime(),
  ...(row.updated_at ? { updatedAt: row.updated_at.getTime() } : {}),
  collageJson: JSON.stringify(row.collage_json),
  imageUrl: row.image_url,
  public: row.public,
  nsfw: row.nsfw,
  version: 1,
}));
const preferences = snapshot.preferences.map((row) => ({
  userId: row.id,
  createdAt: row.created_at.getTime(),
  ...(row.updated_at ? { updatedAt: row.updated_at.getTime() } : {}),
  showNsfw: row.show_nsfw,
  tutorialViewed: row.tutorial_viewed,
  version: 1,
}));
const nextValue = (collages.at(-1)?.legacyId ?? 0) + 1;
const files = {
  "collages.jsonl": jsonLines(collages),
  "userPreferences.jsonl": jsonLines(preferences),
  "idCounters.jsonl": jsonLines([{ name: "collages", nextValue }]),
};

await Promise.all(
  Object.entries(files).map(([filename, contents]) =>
    writeFile(path.join(artifactDirectory, filename), contents, {
      mode: 0o600,
    }),
  ),
);
const manifest = {
  exportedAt: new Date().toISOString(),
  counts: {
    collages: collages.length,
    userPreferences: preferences.length,
  },
  maximumLegacyId: nextValue - 1,
  files: Object.fromEntries(
    Object.entries(files).map(([filename, contents]) => [
      filename,
      createHash("sha256").update(contents).digest("hex"),
    ]),
  ),
};
await writeFile(
  path.join(artifactDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(
  `Exported ${collages.length} collages and ${preferences.length} preference rows to ${artifactDirectory}`,
);
