// storage-adapter-import-placeholder
import { postgresAdapter } from "@payloadcms/db-postgres";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { uploadthingStorage } from "@payloadcms/storage-uploadthing";
import { s3Storage } from "@payloadcms/storage-s3";
import path from "path";
import { buildConfig } from "payload";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { Backgrounds } from "./collections/Backgrounds";
import { Categories } from "./collections/Categories";
import { Media } from "./collections/Media";
import OrderedCategories from "./collections/OrderedCategories";
import { Users } from "./collections/Users";
import { collages, userPreferences } from "./server/db/schema";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const payloadUsesR2 = process.env.PAYLOAD_STORAGE_SOURCE === "r2";

function payloadR2Value(name: string, value: string | undefined): string {
  if (payloadUsesR2 && !value) {
    throw new Error(`${name} is required when PAYLOAD_STORAGE_SOURCE=r2`);
  }
  return value ?? "r2-not-configured";
}

const payloadR2Bucket = payloadR2Value("R2_BUCKET", process.env.R2_BUCKET);
const payloadR2Endpoint = payloadR2Value(
  "R2_ENDPOINT",
  process.env.R2_ENDPOINT,
);
const payloadR2PublicUrl = payloadR2Value(
  "R2_PUBLIC_URL",
  process.env.R2_PUBLIC_URL,
).replace(/\/$/, "");
const payloadR2AccessKeyId = payloadR2Value(
  "R2_ACCESS_KEY_ID",
  process.env.R2_ACCESS_KEY_ID,
);
const payloadR2SecretAccessKey = payloadR2Value(
  "R2_SECRET_ACCESS_KEY",
  process.env.R2_SECRET_ACCESS_KEY,
);

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Media, Categories],
  globals: [Backgrounds, OrderedCategories],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET ?? "",
  typescript: {
    outputFile: path.resolve(dirname, "payload-types.ts"),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI ?? "",
    },
    beforeSchemaInit: [
      ({ schema }) => {
        return {
          ...schema,
          tables: {
            ...schema.tables,
            collages,
            userPreferences,
          },
        };
      },
    ],
  }),
  sharp,
  plugins: [
    uploadthingStorage({
      enabled: !payloadUsesR2,
      collections: {
        media: {
          disablePayloadAccessControl: true,
        },
      },
      options: {
        token: process.env.UPLOADTHING_TOKEN,
        acl: "public-read",
        logLevel: "Debug",
      },
    }),
    s3Storage({
      enabled: payloadUsesR2,
      collections: {
        media: {
          disablePayloadAccessControl: true,
          prefix: "payload/media",
          generateFileURL: ({ filename }) =>
            `${payloadR2PublicUrl}/payload/media/${filename}?v=r2-20260716-2`,
        },
      },
      bucket: payloadR2Bucket,
      config: {
        credentials: {
          accessKeyId: payloadR2AccessKeyId,
          secretAccessKey: payloadR2SecretAccessKey,
        },
        region: "auto",
        endpoint: payloadR2Endpoint,
        forcePathStyle: true,
      },
    }),
  ],
});
