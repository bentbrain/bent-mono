import "server-only";

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { env } from "@/env";

const COLLAGE_CONTENT_TYPE = "image/jpeg";
const MAX_COLLAGE_BYTES = 4 * 1024 * 1024;
const PRESIGNED_UPLOAD_TTL_SECONDS = 5 * 60;
const COLLAGE_KEY_PATTERN = /^collages\/[a-f0-9]{32}\.jpg$/;

type R2Config = {
  bucket: string;
  endpoint: string;
  publicUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type R2UploadTarget = {
  provider: "r2";
  key: string;
  uploadUrl: string;
  publicUrl: string;
  contentType: "image/jpeg";
  maxBytes: number;
};

function requireR2Config(): R2Config {
  const values = {
    bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT,
    publicUrl: env.R2_PUBLIC_URL,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };

  const missing = Object.entries(values)
    .filter((entry) => !entry[1])
    .map((entry) => entry[0]);
  if (missing.length > 0) {
    throw new Error(`Missing R2 configuration: ${missing.join(", ")}`);
  }

  const { bucket, endpoint, publicUrl, accessKeyId, secretAccessKey } = values;
  if (!bucket || !endpoint || !publicUrl || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 configuration is incomplete");
  }
  return { bucket, endpoint, publicUrl, accessKeyId, secretAccessKey };
}

let r2Client: S3Client | undefined;

function getR2Client(config: R2Config): S3Client {
  r2Client ??= new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return r2Client;
}

function publicObjectUrl(publicUrl: string, key: string): string {
  const base = publicUrl.endsWith("/") ? publicUrl.slice(0, -1) : publicUrl;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${base}/${encodedKey}`;
}

export async function createCollageRenderUpload(): Promise<R2UploadTarget> {
  const config = requireR2Config();
  const key = `collages/${randomBytes(16).toString("hex")}.jpg`;
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: COLLAGE_CONTENT_TYPE,
  });
  const uploadUrl = await getSignedUrl(getR2Client(config), command, {
    expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS,
  });

  return {
    provider: "r2",
    key,
    uploadUrl,
    publicUrl: publicObjectUrl(config.publicUrl, key),
    contentType: COLLAGE_CONTENT_TYPE,
    maxBytes: MAX_COLLAGE_BYTES,
  };
}

export async function verifyCollageRenderUpload(imageUrl: string) {
  const config = requireR2Config();
  const publicBase = new URL(config.publicUrl);
  const image = new URL(imageUrl);
  if (image.origin !== publicBase.origin) {
    throw new Error("The collage image does not use the configured R2 domain");
  }

  const key = decodeURIComponent(image.pathname.replace(/^\//, ""));
  if (!COLLAGE_KEY_PATTERN.test(key)) {
    throw new Error("The collage image has an invalid R2 object key");
  }

  const object = await getR2Client(config).send(
    new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
  );
  if (object.ContentType !== COLLAGE_CONTENT_TYPE) {
    throw new Error("The uploaded collage is not a JPEG image");
  }
  if (object.ContentLength === undefined || object.ContentLength < 1) {
    throw new Error("The uploaded collage is empty");
  }
  if (object.ContentLength > MAX_COLLAGE_BYTES) {
    throw new Error("The uploaded collage exceeds the 4 MB limit");
  }

  return { key, size: object.ContentLength };
}
