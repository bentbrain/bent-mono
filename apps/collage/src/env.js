import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const uploadThingTokenPayloadSchema = z.object({
  apiKey: z.string().startsWith("sk_"),
  appId: z.string().min(1),
  regions: z.array(z.string().min(1)).min(1),
});

const uploadThingTokenSchema = z.string().refine((token) => {
  try {
    /** @type {unknown} */
    const payload = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    return uploadThingTokenPayloadSchema.safeParse(payload).success;
  } catch {
    return false;
  }
}, "Must be a valid UploadThing v7 token");

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    DATABASE_URI: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PAYLOAD_SECRET: z.string(),
    UPLOADTHING_TOKEN: uploadThingTokenSchema,
    CLERK_SECRET_KEY: z.string(),
    DB_READ_SOURCE: z.enum(["postgres", "convex"]).default("postgres"),
    DB_WRITE_SOURCE: z.enum(["postgres", "convex"]).default("postgres"),
    MIGRATION_MAINTENANCE_MODE: z
      .enum(["false", "true"])
      .default("false")
      .transform((value) => value === "true"),
    STORAGE_WRITE_SOURCE: z.enum(["uploadthing", "r2"]).default("uploadthing"),
    PAYLOAD_STORAGE_SOURCE: z
      .enum(["uploadthing", "r2"])
      .default("uploadthing"),
    R2_BUCKET: z.string().min(1).optional(),
    R2_ENDPOINT: z.string().url().optional(),
    R2_PUBLIC_URL: z.string().url().optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string(),
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.string(),
    NEXT_PUBLIC_CONVEX_URL: z.string().url().optional(),
    NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DATABASE_URI: process.env.DATABASE_URI,
    NODE_ENV: process.env.NODE_ENV,
    PAYLOAD_SECRET: process.env.PAYLOAD_SECRET,
    UPLOADTHING_TOKEN: process.env.UPLOADTHING_TOKEN,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    DB_READ_SOURCE: process.env.DB_READ_SOURCE,
    DB_WRITE_SOURCE: process.env.DB_WRITE_SOURCE,
    MIGRATION_MAINTENANCE_MODE: process.env.MIGRATION_MAINTENANCE_MODE,
    STORAGE_WRITE_SOURCE: process.env.STORAGE_WRITE_SOURCE,
    PAYLOAD_STORAGE_SOURCE: process.env.PAYLOAD_STORAGE_SOURCE,
    R2_BUCKET: process.env.R2_BUCKET,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL,
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
